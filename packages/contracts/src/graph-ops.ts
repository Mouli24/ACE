import { z } from 'zod';

import type { NodeKind } from './enums.js';
import {
  EdgeSchema,
  IdSchema,
  LoopConfigSchema,
  NODE_CONFIG_SCHEMA_BY_KIND,
  NodeHandleSchema,
  NodeNameSchema,
  NodeSchema,
  PositionSchema,
} from './graph.js';

/**
 * Remove `.default()` from a field, however many times it was applied.
 *
 * D-001: `.partial()` makes a key optional but leaves its `.default()` in place, so a patch that
 * never mentioned `execution` still parses to one. The engine then shallow-merges that over the
 * stored config and silently reverts whatever the user had set.
 */
function withoutDefault(field: z.ZodType): z.ZodType {
  let current = field;
  while (current instanceof z.ZodDefault) current = current.unwrap() as z.ZodType;
  return current;
}

/**
 * The patch schema for one config schema: every key optional, no key able to invent itself.
 *
 * Derived from the config schema rather than hand-written as a parallel `AgentConfigPatchSchema`.
 * A second copy of the field list is a second thing to remember, and the day someone adds a field
 * to `AgentConfig` and forgets the patch schema is the day D-001 comes back wearing a new hat.
 */
function patchSchemaOf<T extends z.ZodObject>(schema: T) {
  return z
    .object(
      Object.fromEntries(
        Object.entries(schema.shape).map(([key, field]) => [key, withoutDefault(field as z.ZodType)]),
      ),
    )
    .partial();
}

/**
 * The patch schema per node kind — what the engine validates a patch against once it knows the
 * node's kind. Shallow, like TypeScript's `Partial`: a patch that names `execution` replaces the
 * whole `execution` object (and that object's own defaults still fill in what it left out), while
 * a key the patch never names is not touched at all.
 */
export const NODE_CONFIG_PATCH_SCHEMA_BY_KIND = {
  input: patchSchemaOf(NODE_CONFIG_SCHEMA_BY_KIND.input),
  output: patchSchemaOf(NODE_CONFIG_SCHEMA_BY_KIND.output),
  agent: patchSchemaOf(NODE_CONFIG_SCHEMA_BY_KIND.agent),
  model: patchSchemaOf(NODE_CONFIG_SCHEMA_BY_KIND.model),
  merge: patchSchemaOf(NODE_CONFIG_SCHEMA_BY_KIND.merge),
  transform: patchSchemaOf(NODE_CONFIG_SCHEMA_BY_KIND.transform),
  retrieval: patchSchemaOf(NODE_CONFIG_SCHEMA_BY_KIND.retrieval),
  guardrail: patchSchemaOf(NODE_CONFIG_SCHEMA_BY_KIND.guardrail),
  custom: patchSchemaOf(NODE_CONFIG_SCHEMA_BY_KIND.custom),
} as const;

/**
 * `Partial<NodeConfig>` (round 1 §2.6). The patch carries no `kind`, so at request-parse time the
 * only honest check is "some node config, partially filled"; the engine knows the node's kind and
 * re-validates with `nodeConfigPatchSchema(kind)` before applying.
 *
 * Each member is **loose**. A strict `z.object` strips keys it does not declare, and since every
 * member here is fully optional the first one would match any patch and silently delete the very
 * field being set — an `execution` patch would parse to `{}` and the update would do nothing. The
 * keys have to survive request parsing so that `nodeConfigPatchSchema(kind)` can reject a bad one.
 *
 * These members are default-free too (D-001). Whichever one happens to match first must not add a
 * key the caller never sent, because the engine parses *this* output, not the raw request body.
 */
export const NodeConfigPatchSchema = z.union([
  NODE_CONFIG_PATCH_SCHEMA_BY_KIND.input.loose(),
  NODE_CONFIG_PATCH_SCHEMA_BY_KIND.output.loose(),
  NODE_CONFIG_PATCH_SCHEMA_BY_KIND.agent.loose(),
  NODE_CONFIG_PATCH_SCHEMA_BY_KIND.model.loose(),
  NODE_CONFIG_PATCH_SCHEMA_BY_KIND.merge.loose(),
  NODE_CONFIG_PATCH_SCHEMA_BY_KIND.transform.loose(),
  NODE_CONFIG_PATCH_SCHEMA_BY_KIND.retrieval.loose(),
  NODE_CONFIG_PATCH_SCHEMA_BY_KIND.guardrail.loose(),
  NODE_CONFIG_PATCH_SCHEMA_BY_KIND.custom.loose(),
]);
export type NodeConfigPatch = z.infer<typeof NodeConfigPatchSchema>;

/** The strict patch schema for one node kind — what the engine validates against. */
export function nodeConfigPatchSchema<K extends NodeKind>(kind: K) {
  return NODE_CONFIG_PATCH_SCHEMA_BY_KIND[kind];
}

export const NodePatchSchema = z.object({
  name: NodeNameSchema.optional(),
  /** D308: set a handle, or `null` to go back to the default (a slug of the name). */
  handle: NodeHandleSchema.nullable().optional(),
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
