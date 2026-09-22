import { describe, expect, it } from 'vitest';

import {
  ModelListResponseSchema,
  ModelQuerySchema,
  ModelSchema,
  RefreshModelsResponseSchema,
  modelMatchesQuery,
  type Model,
} from '../models.js';
import { MODEL_ROW_ID, NOW, PROVIDER_ID } from './fixtures.js';

const model = {
  id: MODEL_ROW_ID,
  providerId: PROVIDER_ID,
  modelId: 'mock-text',
  displayName: 'Mock text',
  inputTypes: ['text'],
  outputTypes: ['text'],
  contextWindow: 200_000,
  supportsTools: false,
  supportsJson: false,
  available: true,
  source: 'discovered',
  lastCheckedAt: NOW,
};

describe('FR-MOD-003 Model', () => {
  it('records every field §2.1 lists', () => {
    expect(ModelSchema.parse(model)).toEqual(model);
  });

  it('refuses a data type that is not a DataType', () => {
    expect(ModelSchema.safeParse({ ...model, inputTypes: ['picture'] }).success).toBe(false);
    expect(ModelSchema.safeParse({ ...model, outputTypes: ['picture'] }).success).toBe(false);
  });

  it('refuses a context window that is not a positive integer', () => {
    expect(ModelSchema.safeParse({ ...model, contextWindow: 0 }).success).toBe(false);
    expect(ModelSchema.safeParse({ ...model, contextWindow: 8192.5 }).success).toBe(false);
  });

  it('refuses a modelId that is not the provider-side id string', () => {
    expect(ModelSchema.safeParse({ ...model, modelId: '' }).success).toBe(false);
  });
});

describe('FR-MOD-001 / FR-MOD-002 discovery and manifest', () => {
  it('records where the row came from, and nothing else', () => {
    expect(ModelSchema.parse({ ...model, source: 'manifest' }).source).toBe('manifest');
    expect(ModelSchema.safeParse({ ...model, source: 'guessed' }).success).toBe(false);
  });
});

describe('FR-OBS-003 versioned pricing on a catalog row', () => {
  it('carries the per-1k prices with the price table version they came from', () => {
    const pricing = { inputPer1k: 0.001, outputPer1k: 0.002, priceTableVersion: 'mock-v1' };

    expect(ModelSchema.parse({ ...model, pricing }).pricing).toEqual(pricing);
  });

  it('is optional, because a local model has no price', () => {
    expect(ModelSchema.parse(model).pricing).toBeUndefined();
  });

  it('refuses pricing without the version that makes an old estimate reproducible', () => {
    expect(
      ModelSchema.safeParse({ ...model, pricing: { inputPer1k: 0.001, outputPer1k: 0.002 } })
        .success,
    ).toBe(false);
  });

  it('refuses a negative price', () => {
    expect(
      ModelSchema.safeParse({
        ...model,
        pricing: { inputPer1k: -0.001, outputPer1k: 0.002, priceTableVersion: 'mock-v1' },
      }).success,
    ).toBe(false);
  });
});

describe('TC-MOD-003 ModelQuery', () => {
  it('takes every filter of §2.5 and none of them are required', () => {
    expect(ModelQuerySchema.parse({})).toEqual({});
    expect(
      ModelQuerySchema.parse({
        providerId: PROVIDER_ID,
        inputType: 'image',
        outputType: 'text',
        available: true,
      }),
    ).toEqual({ providerId: PROVIDER_ID, inputType: 'image', outputType: 'text', available: true });
  });

  it('reads `available` out of a query string as well as a body', () => {
    expect(ModelQuerySchema.parse({ available: 'true' }).available).toBe(true);
    expect(ModelQuerySchema.parse({ available: 'false' }).available).toBe(false);
  });

  it('refuses a filter value that is not a DataType or a ULID', () => {
    expect(ModelQuerySchema.safeParse({ inputType: 'picture' }).success).toBe(false);
    expect(ModelQuerySchema.safeParse({ providerId: 'prov-1' }).success).toBe(false);
    expect(ModelQuerySchema.safeParse({ available: 'maybe' }).success).toBe(false);
  });
});

describe('TC-MOD-003 modelMatchesQuery', () => {
  const vision: Model = ModelSchema.parse({
    ...model,
    modelId: 'mock-vision',
    inputTypes: ['text', 'image'],
  });
  const text: Model = ModelSchema.parse(model);
  const unavailable: Model = ModelSchema.parse({ ...model, available: false });

  it('matches everything when nothing is filtered', () => {
    expect(modelMatchesQuery(text, {})).toBe(true);
  });

  it('narrows by input type — image input keeps only the vision model', () => {
    expect(modelMatchesQuery(vision, { inputType: 'image' })).toBe(true);
    expect(modelMatchesQuery(text, { inputType: 'image' })).toBe(false);
  });

  it('narrows by output type', () => {
    expect(modelMatchesQuery(text, { outputType: 'text' })).toBe(true);
    expect(modelMatchesQuery(text, { outputType: 'json' })).toBe(false);
  });

  it('narrows by provider', () => {
    expect(modelMatchesQuery(text, { providerId: PROVIDER_ID })).toBe(true);
    expect(modelMatchesQuery(text, { providerId: MODEL_ROW_ID })).toBe(false);
  });

  it('narrows by availability in both directions', () => {
    expect(modelMatchesQuery(unavailable, { available: true })).toBe(false);
    expect(modelMatchesQuery(unavailable, { available: false })).toBe(true);
  });

  it('applies every filter at once', () => {
    expect(
      modelMatchesQuery(vision, { providerId: PROVIDER_ID, inputType: 'image', available: true }),
    ).toBe(true);
    expect(
      modelMatchesQuery(vision, { providerId: PROVIDER_ID, inputType: 'audio', available: true }),
    ).toBe(false);
  });
});

describe('FR-MOD-006 catalog responses carry the refresh time', () => {
  it('answers GET /models with items and refreshedAt', () => {
    const body = { items: [model], refreshedAt: NOW };

    expect(ModelListResponseSchema.parse(body)).toEqual(body);
    expect(ModelListResponseSchema.safeParse({ items: [model] }).success).toBe(false);
  });

  it('answers POST /providers/:id/refresh-models with models and refreshedAt', () => {
    const body = { models: [model], refreshedAt: NOW };

    expect(RefreshModelsResponseSchema.parse(body)).toEqual(body);
    expect(RefreshModelsResponseSchema.safeParse({ models: [model] }).success).toBe(false);
  });
});
