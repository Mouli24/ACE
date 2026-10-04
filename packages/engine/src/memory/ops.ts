import {
  MEMORY_OUTPUT_FIELD,
  MEMORY_VALUE_MAX,
  MemoryOpsSchema,
  type MemoryOp,
} from '@ace/contracts';

import { maskSecrets } from '../security/secret-patterns.js';

/**
 * Reading an agent's memory ops out of its output (FR-MEM-002, round 5 §2.2).
 *
 * The `__memory` field is taken out of the output whatever it holds, so it can never reach the
 * contract check or the next node. A list that does not parse is ignored as a whole — half-applying
 * a malformed list would be worse than applying none — and the reason travels back to the caller.
 */
export function extractMemoryOps(value: unknown): {
  value: unknown;
  ops: MemoryOp[];
  invalid?: string;
} {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { value, ops: [] };
  }
  if (!(MEMORY_OUTPUT_FIELD in value)) return { value, ops: [] };

  const { [MEMORY_OUTPUT_FIELD]: raw, ...rest } = value as Record<string, unknown>;
  const parsed = MemoryOpsSchema.safeParse(raw);
  if (parsed.success) return { value: rest, ops: parsed.data };

  const issue = parsed.error.issues[0];
  const where = issue === undefined || issue.path.length === 0 ? '' : ` at ${issue.path.join('.')}`;
  return {
    value: rest,
    ops: [],
    invalid: `${MEMORY_OUTPUT_FIELD} ignored: ${issue?.message ?? 'not a list of memory ops'}${where}`,
  };
}

/**
 * A model-written value is masked before it is stored (D86): the storage layer refuses a
 * key-shaped string, and a memory the agent saved must not turn into a failed run.
 */
export function maskMemoryValue(value: string): string {
  const masked = maskSecrets(value);
  return masked.length > MEMORY_VALUE_MAX ? masked.slice(0, MEMORY_VALUE_MAX) : masked;
}
