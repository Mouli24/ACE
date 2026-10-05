import {
  MEMORY_OUTPUT_FIELD,
  MEMORY_VALUE_MAX,
  MemoryOpSchema,
  MemoryOpsSchema,
  type MemoryOp,
} from '@ace/contracts';
import { z } from 'zod';

import { maskSecrets } from '../security/secret-patterns.js';

/**
 * Reading an agent's memory ops out of its output (FR-MEM-002, round 5 §2.2).
 *
 * The `__memory` field is taken out of the output whatever it holds, so it can never reach the
 * contract check or the next node. A field that is not a list is ignored whole; inside a list each op
 * is judged on its own — a malformed op, or one whose key looks like a credential, is dropped while
 * the valid ops still apply — and every reason travels back to the caller in `invalid`.
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
  if (!Array.isArray(raw)) {
    return {
      value: rest,
      ops: [],
      invalid: `${MEMORY_OUTPUT_FIELD} ignored: not a list of memory ops`,
    };
  }

  // Op by op: a bad op is dropped with a reason and the good ones still apply. An op whose key
  // masking would change is a key-shaped key; it is dropped rather than stored as "[REDACTED]".
  const ops: MemoryOp[] = [];
  const problems: string[] = [];
  raw.forEach((candidate: unknown, index) => {
    const parsed = MemoryOpSchema.safeParse(candidate);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue === undefined ? '' : issue.path.join('.');
      problems.push(
        `op ${index}: ${issue?.message ?? 'invalid'}${path === '' ? '' : ` at ${path}`}`,
      );
    } else if (maskSecrets(parsed.data.key) !== parsed.data.key) {
      problems.push(`op ${index}: key looks like a credential`);
    } else {
      ops.push(parsed.data);
    }
  });
  return problems.length === 0
    ? { value: rest, ops }
    : {
        value: rest,
        ops,
        invalid: `${MEMORY_OUTPUT_FIELD} ignored in part: ${problems.join('; ')}`,
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

/**
 * The JSON Schema of a `__memory` list, derived from the contract's own `MemoryOpsSchema` so the
 * provider is held to exactly the ops `extractMemoryOps` accepts (FR-MEM-002).
 */
const MEMORY_OPS_JSON_SCHEMA: Record<string, unknown> = (() => {
  const { $schema: _dialect, ...schema } = z.toJSONSchema(MemoryOpsSchema);
  return schema;
})();

/**
 * The schema an agent with memory on holds its provider to (13a review m2): its own output schema,
 * with an optional `__memory` list beside its properties. A provider that enforces the schema could
 * not emit `__memory` otherwise. Only an object schema can carry the field — §2.2 makes `__memory` a
 * field of the JSON output — so any other schema, and one that already names the field, comes back
 * as it was. `required` is never touched, and the agent's own schema is never changed: the answer is
 * validated against it once `__memory` is out.
 */
export function withMemoryField(schema: Record<string, unknown>): Record<string, unknown> {
  const { type, properties } = schema;
  const isObjectSchema =
    type === 'object' ||
    (type === undefined && properties !== null && typeof properties === 'object');
  if (!isObjectSchema) return schema;

  const existing =
    properties !== null && typeof properties === 'object' && !Array.isArray(properties)
      ? (properties as Record<string, unknown>)
      : {};
  if (MEMORY_OUTPUT_FIELD in existing) return schema;

  return {
    ...schema,
    properties: { ...existing, [MEMORY_OUTPUT_FIELD]: MEMORY_OPS_JSON_SCHEMA },
  };
}
