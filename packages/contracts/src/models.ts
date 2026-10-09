import { z } from 'zod';

import { DataTypeSchema } from './enums.js';
import { IdSchema, TimestampSchema } from './graph.js';

/**
 * The model catalog (round 2 §2.1, FR-MOD-001..006, Arch §14.4).
 *
 * One row per provider model, however it was found: `discovered` from the provider's own listing,
 * or `manifest` from the versioned catalog file the engine ships for providers that cannot list.
 */

export const MODEL_SOURCES = ['discovered', 'manifest'] as const;
export const ModelSourceSchema = z.enum(MODEL_SOURCES);
export type ModelSource = z.infer<typeof ModelSourceSchema>;

/**
 * Price per 1 000 tokens, stamped with the price table version in force (FR-OBS-003). The version
 * is required: without it an old run's estimate could not be reproduced after a price change.
 */
export const ModelPricingSchema = z.object({
  inputPer1k: z.number().min(0),
  outputPer1k: z.number().min(0),
  priceTableVersion: z.string().min(1),
});
export type ModelPricing = z.infer<typeof ModelPricingSchema>;

export const ModelSchema = z.object({
  /** The catalog row's own id — `modelId` is the provider-side name, which is not unique. */
  id: IdSchema,
  providerId: IdSchema,
  modelId: z.string().min(1),
  displayName: z.string().min(1),
  inputTypes: z.array(DataTypeSchema),
  outputTypes: z.array(DataTypeSchema),
  contextWindow: z.number().int().positive(),
  supportsTools: z.boolean(),
  supportsJson: z.boolean(),
  available: z.boolean(),
  source: ModelSourceSchema,
  lastCheckedAt: TimestampSchema,
  pricing: ModelPricingSchema.optional(),
  /** The provider's own one-line description of the model, when its listing carries one. */
  description: z.string().optional(),
  /**
   * The exact model an alias stands for right now, as the provider reported it — `opus` →
   * `claude-opus-5-5`. Absent when `modelId` is already the full name or the provider does not say.
   */
  resolvedModelId: z.string().optional(),
  /** Why an `available: false` model cannot be used, in the provider's words or the engine's. */
  unavailableReason: z.string().optional(),
});
export type Model = z.infer<typeof ModelSchema>;

/**
 * `GET /models?providerId&inputType&outputType&available` (FR-MOD-004). Every filter is optional
 * and `available` is read from a query string as readily as from a body.
 */
export const ModelQuerySchema = z.object({
  providerId: IdSchema.optional(),
  inputType: DataTypeSchema.optional(),
  outputType: DataTypeSchema.optional(),
  available: z.union([z.boolean(), z.stringbool()]).optional(),
});
export type ModelQuery = z.infer<typeof ModelQuerySchema>;

/**
 * Does one catalog row satisfy a query? Pure, so the engine's `GET /models` and the config
 * panel's client-side narrowing cannot disagree about what "supports image input" means (D52).
 * A type filter asks whether the model *covers* that type, not whether it is the only one.
 */
export function modelMatchesQuery(model: Model, query: ModelQuery): boolean {
  if (query.providerId !== undefined && model.providerId !== query.providerId) return false;
  if (query.inputType !== undefined && !model.inputTypes.includes(query.inputType)) return false;
  if (query.outputType !== undefined && !model.outputTypes.includes(query.outputType)) return false;
  if (query.available !== undefined && model.available !== query.available) return false;
  return true;
}

/** `GET /models` (§2.5). */
export const ModelListResponseSchema = z.object({
  items: z.array(ModelSchema),
  refreshedAt: TimestampSchema,
});
export type ModelListResponse = z.infer<typeof ModelListResponseSchema>;

/** `POST /providers/:id/refresh-models` (§2.5, FR-MOD-006). */
export const RefreshModelsResponseSchema = z.object({
  models: z.array(ModelSchema),
  refreshedAt: TimestampSchema,
  /**
   * Set when the provider could not list its models — a CLI that is not installed or not signed in.
   * The models already known are then returned `available: false`, never guessed at.
   */
  warning: z.string().optional(),
});
export type RefreshModelsResponse = z.infer<typeof RefreshModelsResponseSchema>;
