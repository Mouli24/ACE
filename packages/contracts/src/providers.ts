import { z } from 'zod';

import { ProviderStateSchema, ProviderTypeSchema } from './enums.js';
import { IdSchema, TimestampSchema } from './graph.js';

/**
 * Providers (round 2 §2.1, FR-PRV-001..010, Arch §14.1).
 *
 * The one rule that shapes this module: an API key is never part of a `Provider`. It arrives on a
 * create or update request, goes to the `SecretStore`, and the only trace it leaves in the API is
 * the derived `keySet` boolean (FR-PRV-002, BR-07).
 */

export const ProviderNameSchema = z.string().min(1).max(80);

/** A provider's base URL — `openai_compatible` and `ollama` need one; the cloud types do not. */
export const ProviderBaseUrlSchema = z.url();

/**
 * How many calls the engine may have in flight against one provider (FR-PRV-009). D28: the bound
 * is §2.1's 1..64 and the default is the engine-wide `DEFAULT_CONCURRENCY`, so a provider added
 * without a limit is throttled by the global semaphore alone rather than by a number no doc names.
 */
export const PROVIDER_CONCURRENCY_MIN = 1;
export const PROVIDER_CONCURRENCY_MAX = 64;
export const DEFAULT_PROVIDER_CONCURRENCY = 20;

export const ProviderConcurrencySchema = z
  .number()
  .int()
  .min(PROVIDER_CONCURRENCY_MIN)
  .max(PROVIDER_CONCURRENCY_MAX);

export const ProviderSchema = z.object({
  id: IdSchema,
  type: ProviderTypeSchema,
  name: ProviderNameSchema,
  baseUrl: ProviderBaseUrlSchema.optional(),
  /** Derived from the SecretStore at read time — never a key, only whether one exists. */
  keySet: z.boolean(),
  status: ProviderStateSchema,
  statusMessage: z.string().optional(),
  lastCheckedAt: TimestampSchema.optional(),
  concurrency: ProviderConcurrencySchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Provider = z.infer<typeof ProviderSchema>;

/** `POST /providers`. `apiKey` is stored in the keychain and never written to the DB (§2.1). */
export const CreateProviderRequestSchema = z.object({
  type: ProviderTypeSchema,
  name: ProviderNameSchema,
  apiKey: z.string().min(1).optional(),
  baseUrl: ProviderBaseUrlSchema.optional(),
  concurrency: ProviderConcurrencySchema.default(DEFAULT_PROVIDER_CONCURRENCY),
});
export type CreateProviderRequest = z.infer<typeof CreateProviderRequestSchema>;

/** `PATCH /providers/:id`. An `apiKey` present in the patch rotates the stored key (§2.1). */
export const UpdateProviderRequestSchema = z.object({
  name: ProviderNameSchema.optional(),
  apiKey: z.string().min(1).optional(),
  baseUrl: ProviderBaseUrlSchema.optional(),
  concurrency: ProviderConcurrencySchema.optional(),
});
export type UpdateProviderRequest = z.infer<typeof UpdateProviderRequestSchema>;

/** `POST /providers/:id/check` (FR-PRV-003); also the payload behind `provider.status`. */
export const ProviderCheckResultSchema = z.object({
  status: ProviderStateSchema,
  message: z.string().optional(),
  latencyMs: z.number().min(0).optional(),
  checkedAt: TimestampSchema,
});
export type ProviderCheckResult = z.infer<typeof ProviderCheckResultSchema>;

/** The address the engine probes for a local Ollama (FR-PRV-007). */
export const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';

/** `GET /providers/detect` — absent key means nothing answered on the default address. */
export const ProviderDetectResponseSchema = z.object({
  ollama: z
    .object({
      baseUrl: ProviderBaseUrlSchema,
      detected: z.boolean(),
    })
    .optional(),
});
export type ProviderDetectResponse = z.infer<typeof ProviderDetectResponseSchema>;
