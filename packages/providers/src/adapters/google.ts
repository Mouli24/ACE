import { createGoogleGenerativeAI } from '@ai-sdk/google';

import type { ModelInfo, ProviderAdapter } from '../adapter.js';
import {
  badEmbedResponse,
  byChatName,
  checkVectors,
  createAiSdkAdapter,
  discoveredModel,
  getJson,
  MAX_LIST_PAGES,
  notAChatModel,
  postJson,
  requireEmbedModel,
  statusFromProbe,
  withFamilyDefaults,
  withImageGeneration,
  type FetchLike,
} from './ai-sdk.js';

/**
 * Google Generative AI (FR-PRV-001). Its listing carries the key as a query parameter and names
 * models `models/<id>`, both of which are normalised here so the catalog sees plain ids.
 */

export const GOOGLE_BASE_URL = 'https://generativelanguage.googleapis.com';

export interface GoogleOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

/**
 * The listing, as models. [audit P-6] `supportedGenerationMethods` says what each one does: a model
 * without `generateContent` cannot chat — an embedder (`embedContent`) is kept, unavailable, for a
 * knowledge base to pick, and one that does neither (an image or video generator) is left out. A
 * chat model whose name says it speaks or draws is still told apart by that name.
 *
 * [audit P-2] Its `inputTokenLimit` is the model's real context window, and a Gemini 1.5+ chat
 * model gets its family's tools, schema and image input.
 */
export function parseGoogleModelList(body: unknown): ModelInfo[] {
  const models = (body as { models?: unknown }).models;
  if (!Array.isArray(models)) return [];

  return models.flatMap((entry): ModelInfo[] => {
    const name = (entry as { name?: unknown }).name;
    if (typeof name !== 'string') return [];
    const displayName = (entry as { displayName?: unknown }).displayName;
    const limit = (entry as { inputTokenLimit?: unknown }).inputTokenLimit;
    const listed = discoveredModel(
      name.replace(/^models\//, ''),
      typeof displayName === 'string' ? displayName : undefined,
    );
    const model: ModelInfo =
      typeof limit === 'number' && Number.isInteger(limit) && limit > 0
        ? { ...listed, contextWindow: limit }
        : listed;
    const methods = (entry as { supportedGenerationMethods?: unknown }).supportedGenerationMethods;
    if (!Array.isArray(methods) || methods.includes('generateContent')) {
      return [withFamilyDefaults(byChatName(model))];
    }
    return methods.includes('embedContent') ? [notAChatModel(model)] : [];
  });
}

export function createGoogleAdapter(options: GoogleOptions): ProviderAdapter {
  const baseUrl = (options.baseUrl ?? GOOGLE_BASE_URL).replace(/\/+$/, '');

  // [audit P-14] The listing is paged (50 by default): ask for the most a page holds, and follow
  // `nextPageToken`.
  const page = async (pageToken?: string): Promise<unknown> => {
    const next = pageToken === undefined ? '' : `&pageToken=${encodeURIComponent(pageToken)}`;
    return getJson({
      url: `${baseUrl}/v1beta/models?key=${encodeURIComponent(options.apiKey)}&pageSize=1000${next}`,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });
  };
  const probe = (): Promise<unknown> => page();
  const listAll = async (): Promise<ModelInfo[]> => {
    const models: ModelInfo[] = [];
    let pageToken: string | undefined;
    for (let pages = 0; pages < MAX_LIST_PAGES; pages += 1) {
      const body = await page(pageToken);
      // D402: a Gemini image model is called through the image path below, so it is usable.
      models.push(...parseGoogleModelList(body).map(withImageGeneration));
      const { nextPageToken } = body as { nextPageToken?: unknown };
      if (typeof nextPageToken !== 'string' || nextPageToken === '') break;
      pageToken = nextPageToken;
    }
    return models;
  };

  const provider = createGoogleGenerativeAI({
    apiKey: options.apiKey,
    baseURL: `${baseUrl}/v1beta`,
    ...(options.fetchImpl === undefined ? {} : { fetch: options.fetchImpl as typeof fetch }),
  });

  return createAiSdkAdapter({
    type: 'google',
    model: (modelId) => provider(modelId),
    image: (modelId) => provider.image(modelId),
    check: () => statusFromProbe(probe),
    listModels: listAll,
    embed: async (texts, embedOptions) => {
      const model = requireEmbedModel(embedOptions);
      if (texts.length === 0) return [];
      const body = (await postJson({
        url: `${baseUrl}/v1beta/models/${model}:batchEmbedContents`,
        headers: { 'x-goog-api-key': options.apiKey },
        body: {
          requests: texts.map((text) => ({
            model: `models/${model}`,
            content: { parts: [{ text }] },
          })),
        },
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      })) as { embeddings?: unknown };
      if (!Array.isArray(body.embeddings)) throw badEmbedResponse('no "embeddings" list');
      return checkVectors(
        (body.embeddings as { values?: unknown }[]).map((entry) => entry.values),
        texts.length,
      );
    },
  });
}
