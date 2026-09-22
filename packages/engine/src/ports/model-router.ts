import type { DataType, ErrorKind, Id, ModelPricing, RoutingPolicy } from '@ace/contracts';

/**
 * The model-router port (Arch §7, §14.3).
 *
 * Declared here rather than in `@ace/providers` for the same reason as the adapter contract: the
 * engine may import only `@ace/contracts` and its own ports (CLAUDE.md §3.4 rule 3).
 * `@ace/providers` implements it and re-exports these types.
 */

/** The fields of a catalog row the router needs. */
export interface RouterModel {
  providerId: Id;
  modelId: string;
  available: boolean;
  inputTypes: DataType[];
  outputTypes: DataType[];
  pricing?: ModelPricing;
}

export interface RoutingNodeConfig {
  providerId?: Id;
  modelId?: string;
  routing: { policy: RoutingPolicy; fallbackModelIds: string[] };
}

/** The data types this node has to be able to read and produce. */
export interface RoutingRequirements {
  inputTypes: readonly DataType[];
  outputTypes: readonly DataType[];
}

/** What has already gone wrong on this node run, in the order it happened. */
export interface AttemptState {
  failures: readonly { modelId: string; kind: ErrorKind }[];
}

export interface Route {
  providerId: Id;
  modelId: string;
  viaFallback: boolean;
}

export const ROUTE_REFUSAL_CODES = [
  'missing_model',
  'unavailable_model',
  'incompatible_model',
  'no_candidate_left',
  'not_supported_yet',
  'policy_not_allowed',
] as const;
export type RouteRefusalCode = (typeof ROUTE_REFUSAL_CODES)[number];

export type RouteResult =
  | { ok: true; route: Route }
  | { ok: false; code: RouteRefusalCode; reason: string };

export interface ModelRouter {
  resolve(
    node: RoutingNodeConfig,
    requirements: RoutingRequirements,
    attemptState: AttemptState,
  ): RouteResult;
  /** FR-RTR-007: a bench arm must be reproducible, so only fixed routing is allowed. */
  resolveForBench(
    node: RoutingNodeConfig,
    requirements: RoutingRequirements,
    attemptState: AttemptState,
  ): RouteResult;
}
