import { z } from 'zod';

import { IdSchema } from './graph.js';

/**
 * Models on this machine (PG-1.4, D359): the local runtime (Ollama) found and started by the engine
 * itself, its models loaded, unloaded and pulled from the picker, and a one-line "Try this model"
 * for any provider. Every type here is additive; nothing older reads them.
 */

/** Where Ollama is downloaded from — shown as text, never installed for the person. */
export const OLLAMA_DOWNLOAD_URL = 'https://ollama.com/download';

/**
 * `GET /local-runtime` — whether Ollama is installed on the engine's machine, answering, and
 * whether the engine started it (an engine never stops a server the person started).
 */
export const LocalRuntimeStatusSchema = z.strictObject({
  installed: z.boolean(),
  running: z.boolean(),
  startedByAce: z.boolean(),
  baseUrl: z.string().min(1),
  /** The binary found, for display. */
  binaryPath: z.string().optional(),
  /** What `/api/version` answered. */
  version: z.string().optional(),
  /** The `ollama` provider for this runtime, when one exists. */
  providerId: IdSchema.optional(),
  /** Why starting it failed, when the engine tried and it did not answer. */
  error: z.string().optional(),
});
export type LocalRuntimeStatus = z.infer<typeof LocalRuntimeStatusSchema>;

/** One model loaded in memory now (Ollama `/api/ps`). */
export const LocalRunningModelSchema = z.strictObject({
  modelId: z.string().min(1),
  sizeBytes: z.number().int().min(0).optional(),
  /** The part of it held in GPU memory. */
  sizeVramBytes: z.number().int().min(0).optional(),
  /** When Ollama will unload it if nothing uses it. */
  expiresAt: z.string().optional(),
});
export type LocalRunningModel = z.infer<typeof LocalRunningModelSchema>;

/** `GET /providers/:id/local/running`. */
export const LocalRunningModelsResponseSchema = z.strictObject({
  items: z.array(LocalRunningModelSchema),
});
export type LocalRunningModelsResponse = z.infer<typeof LocalRunningModelsResponseSchema>;

/** A model name as Ollama spells it: `llama3.2`, `qwen2.5:7b`, `hf.co/org/model:Q4_K_M`. */
export const LocalModelNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/, 'not a model name');

/** `POST /providers/:id/local/load` and `/unload`. */
export const LocalModelRequestSchema = z.strictObject({ modelId: LocalModelNameSchema });
export type LocalModelRequest = z.infer<typeof LocalModelRequestSchema>;

/** What a load or unload did. `startedRuntime` is set when the engine had to start Ollama first. */
export const LocalModelActionResponseSchema = z.strictObject({
  modelId: z.string().min(1),
  loaded: z.boolean(),
  startedRuntime: z.boolean().optional(),
});
export type LocalModelActionResponse = z.infer<typeof LocalModelActionResponseSchema>;

/** `POST /providers/:id/local/pull` — answered 202 at once; progress rides `model.pull`. */
export const PullModelRequestSchema = z.strictObject({ name: LocalModelNameSchema });
export type PullModelRequest = z.infer<typeof PullModelRequestSchema>;

export const PullModelAcceptedSchema = z.strictObject({
  providerId: IdSchema,
  name: z.string().min(1),
  accepted: z.literal(true),
});
export type PullModelAccepted = z.infer<typeof PullModelAcceptedSchema>;

/**
 * `model.pull` (engine scope, transient): one frame per progress line Ollama streams, and a last
 * one with `done: true` — `error` set when it failed. A pull is worth watching, not replaying.
 */
export const ModelPullPayloadSchema = z.strictObject({
  providerId: IdSchema,
  name: z.string().min(1),
  status: z.string(),
  completed: z.number().min(0).optional(),
  total: z.number().min(0).optional(),
  done: z.boolean(),
  error: z.string().optional(),
});
export type ModelPullPayload = z.infer<typeof ModelPullPayloadSchema>;

/** The longest prompt "Try this model" sends. */
export const TRY_PROMPT_MAX = 4_000;

/** `POST /providers/:id/try` — one non-streaming call, no tools. */
export const TryModelRequestSchema = z.strictObject({
  modelId: z.string().min(1),
  prompt: z.string().trim().min(1).max(TRY_PROMPT_MAX),
});
export type TryModelRequest = z.infer<typeof TryModelRequestSchema>;

export const TryModelResponseSchema = z.strictObject({
  text: z.string(),
  tokensIn: z.number().int().min(0),
  tokensOut: z.number().int().min(0),
  ms: z.number().int().min(0),
  /** What the call cost, when the provider or the catalogue's price says. */
  costUsd: z.number().min(0).optional(),
});
export type TryModelResponse = z.infer<typeof TryModelResponseSchema>;
