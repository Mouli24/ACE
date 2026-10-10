import { z } from 'zod';

import { DataTypeSchema, type DataType } from './enums.js';
import { IdSchema, PortIdSchema, TimestampSchema } from './graph.js';
import { VerdictSchema } from './guardrails.js';
import { SearchScoreSchema } from './knowledge.js';

/**
 * Parts and the envelope (round 2 §2.2, Arch §12.4, BR-02, BR-13, ADR-008).
 *
 * Every handoff between nodes is an `Envelope`: what to read, a bounded context and the contract
 * the output must satisfy. It is deliberately **not** a conversation — every object in this file
 * is strict, so a `messages` or `history` key is a parse error rather than a silent extra field.
 */

/* -------------------------------------------------------------------------- */
/* Part                                                                        */
/* -------------------------------------------------------------------------- */

/** File-like parts carry a reference, never the bytes (D6, BR-02). */
const mediaPart = <T extends 'image' | 'audio' | 'video' | 'file'>(type: T) =>
  z.strictObject({
    type: z.literal(type),
    artifactId: IdSchema,
    mime: z.string().min(1),
    name: z.string().min(1),
    size: z.number().int().min(0),
  });

export const PartSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('text'), text: z.string() }),
  z.strictObject({ type: z.literal('json'), value: z.unknown() }),
  z.strictObject({ type: z.literal('code'), language: z.string().min(1), text: z.string() }),
  mediaPart('image'),
  mediaPart('audio'),
  mediaPart('video'),
  mediaPart('file'),
]);
export type Part = z.infer<typeof PartSchema>;

/**
 * A part's discriminator is its `DataType` — the seven part kinds are exactly the seven data
 * types, which is what lets an output contract be checked against the parts a node produced.
 */
export type PartType = Part['type'];

/* -------------------------------------------------------------------------- */
/* Envelope                                                                    */
/* -------------------------------------------------------------------------- */

export const TRUST_LEVELS = ['trusted', 'untrusted'] as const;
export const TrustLevelSchema = z.enum(TRUST_LEVELS);
export type TrustLevel = z.infer<typeof TrustLevelSchema>;

/**
 * A knowledge-base chunk in an envelope's context, filled from a search hit (round 5 §2.4,
 * FR-RAG-005..007) — which is why its score is a search score, 0..1. Never trusted (BR-13).
 */
export const RetrievedChunkSchema = z.strictObject({
  chunkId: IdSchema,
  text: z.string(),
  score: SearchScoreSchema,
  source: z.string(),
});
export type RetrievedChunk = z.infer<typeof RetrievedChunkSchema>;

/**
 * A remembered fact as the envelope carries it: just the key and the value (round 2 §2.2). The
 * stored row, with its id and times, is `MemoryEntry` in `memory.ts` (round 5 §2.2), which is why
 * this one has its own name (D229).
 */
export const EnvelopeMemoryEntrySchema = z.strictObject({ key: z.string(), value: z.string() });
export type EnvelopeMemoryEntry = z.infer<typeof EnvelopeMemoryEntrySchema>;

/**
 * The most of `budgetTokens` the retrieved chunks and the memory may each take (round 5 §2.2,
 * §4 item 7); the summary has the rest. Chunks that do not fit are dropped lowest score first, and
 * recorded on the node run as `droppedSources`; memory goes in oldest first, truncated to fit.
 */
export const CONTEXT_BUDGET_SHARES = Object.freeze({ retrieved: 0.5, memory: 0.25 } as const);

/**
 * From round 5 the engine fills all three parts (§2.4, §2.5, §2.2) — summary, then retrieved,
 * then memory, the Arch §12.6 order — and every one of them has been through the context
 * guardrails first (FR-GRD-004). Anything retrieved or remembered makes the envelope `untrusted`.
 */
export const EnvelopeContextSchema = z.strictObject({
  summary: z.string().optional(),
  retrieved: z.array(RetrievedChunkSchema).optional(),
  memory: z.array(EnvelopeMemoryEntrySchema).optional(),
  /** The hard cap of FR-EXE-007 — context is built to fit it, never trimmed afterwards. */
  budgetTokens: z.number().int().positive(),
  /** BR-13: anything a model or a tool produced is `untrusted`. */
  trust: TrustLevelSchema,
});
export type EnvelopeContext = z.infer<typeof EnvelopeContextSchema>;

export const EnvelopeContractSchema = z.strictObject({
  outputTypes: z.array(DataTypeSchema).min(1),
  jsonSchema: z.record(z.string(), z.unknown()).optional(),
  maxTokens: z.number().int().positive().optional(),
});
export type EnvelopeContract = z.infer<typeof EnvelopeContractSchema>;

export const EnvelopeSchema = z.strictObject({
  id: IdSchema,
  runId: IdSchema,
  fromNodeId: IdSchema,
  toNodeId: IdSchema,
  /** Loop iterations are 1-based (§2.6 `mock-reject-twice`); a plain run is always iteration 1. */
  iteration: z.number().int().min(1),
  reads: z.array(PartSchema),
  context: EnvelopeContextSchema,
  contract: EnvelopeContractSchema,
  /** The input-point verdicts on this envelope's reads (round 3 §2.2, Arch §12.4). */
  guardrailVerdicts: z.array(VerdictSchema).optional(),
  createdAt: TimestampSchema,
  /**
   * D310: the team envelope (`envelope.sent`) this edge delivery carries. Domain's envelopes are one
   * per message and may fan out; this one is one per edge. Absent on envelopes from before Domain.
   */
  teamEnvelopeId: IdSchema.optional(),
});
export type Envelope = z.infer<typeof EnvelopeSchema>;

/* -------------------------------------------------------------------------- */
/* Merge output (round 3 §2.4, FR-PAR-002)                                     */
/* -------------------------------------------------------------------------- */

/** One input a merge node received. */
export const MergeInputSchema = z.strictObject({
  /** The merge node's own input port it arrived on, by id (D78). */
  port: PortIdSchema.regex(/:in:/, 'must be an input port of the merge node'),
  /** The node that fed it — what the Canvas labels the slot with during a run. */
  nodeId: IdSchema,
  parts: z.array(PartSchema),
});
export type MergeInput = z.infer<typeof MergeInputSchema>;

/**
 * The value of the one `json` part a merge node emits, ordered by input port order. In `all` mode
 * it holds every connected input; in `any` mode only the first to arrive — the other branches
 * still complete and are recorded on their own node runs, but do not feed the merge.
 */
export const MergeOutputSchema = z.strictObject({ inputs: z.array(MergeInputSchema) });
export type MergeOutput = z.infer<typeof MergeOutputSchema>;

/* -------------------------------------------------------------------------- */
/* Output contract checking (FR-EXE-006, TC-EXE-005)                           */
/* -------------------------------------------------------------------------- */

export type ContractCheck = { ok: true } | { ok: false; reason: string };

/**
 * The JSON Schema keywords an output contract may use (D53). A deliberately small subset — enough
 * for the shapes an agent is asked to return, small enough to stay dependency-free in a package
 * the browser bundles. Unknown keywords are ignored rather than rejected, so a richer schema
 * still validates on the parts this subset understands. `minimum` and `maximum` joined in round 3
 * so the review contract's 0..10 score is enforced, not just written down (D74).
 */
export const SUPPORTED_JSON_SCHEMA_KEYWORDS = [
  'type',
  'enum',
  'const',
  'required',
  'properties',
  'additionalProperties',
  'items',
  'minimum',
  'maximum',
] as const;

type JsonSchemaLike = Record<string, unknown>;

function jsonTypeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function typeMatches(actual: string, expected: string): boolean {
  if (expected === 'number') return actual === 'number' || actual === 'integer';
  return actual === expected;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Returns the first reason the value does not satisfy the schema, or `null` when it does. */
function checkJsonSchema(value: unknown, schema: JsonSchemaLike, path: string): string | null {
  const at = path === '' ? 'output' : `"${path}"`;

  if ('const' in schema && !sameValue(value, schema.const)) {
    return `${at} must equal ${JSON.stringify(schema.const)}`;
  }

  const { enum: allowed } = schema;
  if (Array.isArray(allowed) && !allowed.some((option) => sameValue(value, option))) {
    return `${at} must be one of ${JSON.stringify(allowed)}`;
  }

  const expectedTypes =
    typeof schema.type === 'string'
      ? [schema.type]
      : Array.isArray(schema.type)
        ? schema.type.filter((t): t is string => typeof t === 'string')
        : [];

  const actualType = jsonTypeOf(value);
  if (expectedTypes.length > 0 && !expectedTypes.some((t) => typeMatches(actualType, t))) {
    return `${at} must be ${expectedTypes.join(' or ')}, got ${actualType}`;
  }

  // Bounds apply to numbers only, as in JSON Schema; both are inclusive.
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      return `${at} must be >= ${schema.minimum}`;
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      return `${at} must be <= ${schema.maximum}`;
    }
  }

  if (isPlainObject(value)) {
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (typeof key === 'string' && !(key in value)) {
        return `${at} is missing required field "${key}"`;
      }
    }

    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    for (const [key, subSchema] of Object.entries(properties)) {
      if (!(key in value) || !isPlainObject(subSchema)) continue;
      const reason = checkJsonSchema(value[key], subSchema, path === '' ? key : `${path}.${key}`);
      if (reason !== null) return reason;
    }

    if (schema.additionalProperties === false) {
      const declared = new Set(Object.keys(properties));
      const extra = Object.keys(value).find((key) => !declared.has(key));
      if (extra !== undefined) return `${at} has unexpected field "${extra}"`;
    }
  }

  if (Array.isArray(value) && isPlainObject(schema.items)) {
    for (const [index, item] of value.entries()) {
      const reason = checkJsonSchema(item, schema.items, `${path === '' ? 'items' : path}[${index}]`);
      if (reason !== null) return reason;
    }
  }

  return null;
}

/**
 * Check a node's output against the contract its envelope carried (FR-EXE-006, TC-EXE-005). Pure.
 *
 * The output satisfies the contract when the set of part types is exactly the contracted set —
 * a missing type means the node did not deliver, an extra type means it delivered something the
 * downstream ports cannot accept — and every JSON part matches `jsonSchema` when one is given.
 * A failure here is `CONTRACT_VIOLATION`, never `RUN_FAILED` (BR-03).
 */
export function validateAgainstContract(
  output: Part[],
  contract: EnvelopeContract,
): ContractCheck {
  if (output.length === 0) {
    return { ok: false, reason: `Output is empty; the contract requires ${fmt(contract.outputTypes)}.` };
  }

  const produced = new Set<DataType>(output.map((part) => part.type));
  const expected = new Set<DataType>(contract.outputTypes);

  const missing = [...expected].filter((type) => !produced.has(type));
  const unexpected = [...produced].filter((type) => !expected.has(type));

  if (missing.length > 0 || unexpected.length > 0) {
    return {
      ok: false,
      reason: `Output types ${fmt([...produced])} do not satisfy the contract ${fmt([...expected])}.`,
    };
  }

  if (contract.jsonSchema !== undefined) {
    for (const part of output) {
      if (part.type !== 'json') continue;
      const reason = checkJsonSchema(part.value, contract.jsonSchema, '');
      if (reason !== null) return { ok: false, reason };
    }
  }

  return { ok: true };
}

function fmt(types: DataType[]): string {
  return `[${types.join(', ')}]`;
}
