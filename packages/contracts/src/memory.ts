import { z } from 'zod';

import { IdSchema, TimestampSchema } from './graph.js';

/**
 * Agent memory (round 5 §2.2, FR-MEM-001..004, Arch §12.8).
 *
 * Long-term memory is the `agent_memory` table: key/value facts one agent node keeps between runs.
 * It is one of Arch §12.8's four scopes and is kept apart from the other three — short-term is the
 * envelope, knowledge is a knowledge base, cache is `summary_cache`. A memory value was written by
 * a model, so it is **untrusted** wherever it is shown to one (BR-13).
 */

export const MEMORY_KEY_MAX = 80;
export const MEMORY_VALUE_MAX = 2000;

export const MemoryKeySchema = z.string().min(1).max(MEMORY_KEY_MAX);
export const MemoryValueSchema = z.string().min(1).max(MEMORY_VALUE_MAX);

/**
 * One remembered fact. `GET /nodes/:id/memory` answers a bare `MemoryEntry[]`, oldest first — the
 * order entries are injected in (§2.2, §2.9).
 */
export const MemoryEntrySchema = z.strictObject({
  id: IdSchema,
  /** The agent node that keeps it. */
  nodeId: IdSchema,
  key: MemoryKeySchema,
  value: MemoryValueSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  /** When the entry last went into an envelope. */
  lastUsedAt: TimestampSchema.optional(),
});
export type MemoryEntry = z.infer<typeof MemoryEntrySchema>;

/**
 * What an agent asks for in its output (FR-MEM-002). A save of a key the node already has replaces
 * the value; a delete of a key it does not have changes nothing.
 */
export const MemoryOpSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('save'), key: MemoryKeySchema, value: MemoryValueSchema }),
  z.strictObject({ op: z.literal('delete'), key: MemoryKeySchema }),
]);
export type MemoryOp = z.infer<typeof MemoryOpSchema>;

/**
 * The optional field of an agent's JSON output that carries its memory ops: `{ "__memory": [...] }`.
 * The engine takes it out before the output is checked against the contract, so it never reaches
 * `validateAgainstContract` or the next node (§2.2).
 */
export const MEMORY_OUTPUT_FIELD = '__memory';

export const MemoryOpsSchema = z.array(MemoryOpSchema);

/** The heading of the block the prompt manager appends when `memory.enabled` (§2.2). */
export const MEMORY_PROMPT_HEADING = '## Memory operations';
