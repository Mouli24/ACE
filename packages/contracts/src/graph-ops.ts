import { z } from 'zod';

import type { NodeKind } from './enums.js';
import {
  EdgeSchema,
  IdSchema,
  LoopConfigSchema,
  NODE_CONFIG_SCHEMA_BY_KIND,
  NodeNameSchema,
  NodeSchema,
  PositionSchema,
} from './graph.js';

/**
 * `Partial<NodeConfig>` (round 1 §2.6). The patch carries no `kind`, so at request-parse time the
 * only honest check is "some node config, partially filled"; the engine knows the node's kind and
 * re-validates with `nodeConfigPatchSchema(kind)` before applying. Like TypeScript's `Partial`,
 * this is shallow: a patch that sets `execution` replaces the whole object.
 *
 * Each member is **loose**. A strict `z.object` strips keys it does not declare, and since every
 * member here is fully optional the first one would match any patch and silently delete the very
 * field being set — an `execution` patch would parse to `{}` and the update would do nothing. The
 * keys have to survive request parsing so that `nodeConfigPatchSchema(kind)` can reject a bad one.
 */
export const NodeConfigPatchSchema = z.union([
  NODE_CONFIG_SCHEMA_BY_KIND.input.partial().loose(),
  NODE_CONFIG_SCHEMA_BY_KIND.output.partial().loose(),
  NODE_CONFIG_SCHEMA_BY_KIND.agent.partial().loose(),
  NODE_CONFIG_SCHEMA_BY_KIND.model.partial().loose(),
  NODE_CONFIG_SCHEMA_BY_KIND.merge.partial().loose(),
  NODE_CONFIG_SCHEMA_BY_KIND.transform.partial().loose(),
  NODE_CONFIG_SCHEMA_BY_KIND.retrieval.partial().loose(),
  NODE_CONFIG_SCHEMA_BY_KIND.guardrail.partial().loose(),
  NODE_CONFIG_SCHEMA_BY_KIND.custom.partial().loose(),
]);
export type NodeConfigPatch = z.infer<typeof NodeConfigPatchSchema>;

/** The strict patch schema for one node kind — what the engine validates against. */
export function nodeConfigPatchSchema<K extends NodeKind>(kind: K) {
  return NODE_CONFIG_SCHEMA_BY_KIND[kind].partial();
}

export const NodePatchSchema = z.object({
  name: NodeNameSchema.optional(),
  config: NodeConfigPatchSchema.optional(),
});
export type NodePatch = z.infer<typeof NodePatchSchema>;

export const EdgePatchSchema = z.object({ loop: LoopConfigSchema.optional() });
export type EdgePatch = z.infer<typeof EdgePatchSchema>;

/** The seven graph operations of §2.6. Ports are re-derived server-side after `update_node`. */
export const GraphOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add_node'), node: NodeSchema }),
  z.object({ op: z.literal('update_node'), nodeId: IdSchema, patch: NodePatchSchema }),
  z.object({ op: z.literal('move_node'), nodeId: IdSchema, position: PositionSchema }),
  z.object({ op: z.literal('delete_node'), nodeId: IdSchema }),
  z.object({ op: z.literal('add_edge'), edge: EdgeSchema }),
  z.object({ op: z.literal('update_edge'), edgeId: IdSchema, patch: EdgePatchSchema }),
  z.object({ op: z.literal('delete_edge'), edgeId: IdSchema }),
]);
export type GraphOp = z.infer<typeof GraphOpSchema>;

/** One request is one transaction: between 1 and 200 ops (§2.6). */
export const GRAPH_OPS_MIN = 1;
export const GRAPH_OPS_MAX = 200;

export const GraphOpsRequestSchema = z.object({
  baseVersion: z.number().int().min(0),
  ops: z.array(GraphOpSchema).min(GRAPH_OPS_MIN).max(GRAPH_OPS_MAX),
});
export type GraphOpsRequest = z.infer<typeof GraphOpsRequestSchema>;

/** `version` is always `baseVersion + 1`; a stale `baseVersion` is a 409 `stale_version` instead. */
export const GraphOpsResponseSchema = z.object({
  version: z.number().int().min(0),
  nodes: z.array(NodeSchema),
  edges: z.array(EdgeSchema),
});
export type GraphOpsResponse = z.infer<typeof GraphOpsResponseSchema>;
