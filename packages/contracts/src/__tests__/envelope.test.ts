import { describe, expect, it } from 'vitest';

import {
  CONTEXT_BUDGET_SHARES,
  SUPPORTED_JSON_SCHEMA_KEYWORDS,
  EnvelopeContractSchema,
  EnvelopeSchema,
  MergeOutputSchema,
  PartSchema,
  validateAgainstContract,
  type Part,
} from '../envelope.js';
import {
  ARTIFACT_ID,
  ENVELOPE_ID,
  KB_CHUNK_ID,
  NODE_A,
  NODE_B,
  NODE_C,
  NODE_RUN_ID,
  NOW,
  RUN_ID,
  VERDICT_ID,
} from './fixtures.js';

const envelope = {
  id: ENVELOPE_ID,
  runId: RUN_ID,
  fromNodeId: NODE_A,
  toNodeId: NODE_B,
  iteration: 1,
  reads: [{ type: 'text', text: 'summarise this' }],
  context: { budgetTokens: 4000, trust: 'untrusted' },
  contract: { outputTypes: ['text'] },
  createdAt: NOW,
};

/* -------------------------------------------------------------------------- */
/* Part                                                                        */
/* -------------------------------------------------------------------------- */

describe('FR-EXE-005 Part', () => {
  it('carries text', () => {
    expect(PartSchema.parse({ type: 'text', text: 'hello' })).toEqual({
      type: 'text',
      text: 'hello',
    });
  });

  it('carries a json value of any shape, including null', () => {
    expect(PartSchema.parse({ type: 'json', value: { verdict: 'approved' } })).toEqual({
      type: 'json',
      value: { verdict: 'approved' },
    });
    expect(PartSchema.parse({ type: 'json', value: null })).toEqual({ type: 'json', value: null });
  });

  it('carries code with the language it is written in', () => {
    expect(PartSchema.parse({ type: 'code', language: 'ts', text: 'const a = 1;' })).toEqual({
      type: 'code',
      language: 'ts',
      text: 'const a = 1;',
    });
    expect(PartSchema.safeParse({ type: 'code', text: 'const a = 1;' }).success).toBe(false);
  });

  it('refuses a part type that is not one of the seven', () => {
    expect(PartSchema.safeParse({ type: 'embedding', value: [] }).success).toBe(false);
  });

  it('refuses a text part whose text is not a string', () => {
    expect(PartSchema.safeParse({ type: 'text', text: 42 }).success).toBe(false);
  });
});

describe('D6 file-like parts travel as artifact references', () => {
  const file = {
    type: 'file',
    artifactId: ARTIFACT_ID,
    mime: 'application/pdf',
    name: 'brief.pdf',
    size: 12_345,
  };

  it.each(['image', 'audio', 'video', 'file'])('accepts a %s reference', (type) => {
    expect(PartSchema.parse({ ...file, type })).toEqual({ ...file, type });
  });

  it('requires the artifactId — the bytes never travel in the envelope', () => {
    const { artifactId: _artifactId, ...withoutId } = file;

    expect(PartSchema.safeParse(withoutId).success).toBe(false);
  });

  it.each(['mime', 'name', 'size'])('requires %s', (field) => {
    const partial: Record<string, unknown> = { ...file };
    delete partial[field];

    expect(PartSchema.safeParse(partial).success).toBe(false);
  });

  it('refuses an artifactId that is not a ULID', () => {
    expect(PartSchema.safeParse({ ...file, artifactId: 'artifact-1' }).success).toBe(false);
  });

  it('refuses a negative size', () => {
    expect(PartSchema.safeParse({ ...file, size: -1 }).success).toBe(false);
  });

  it('never carries inline bytes', () => {
    expect(PartSchema.safeParse({ ...file, data: 'JVBERi0xLjQK' }).success).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Envelope                                                                    */
/* -------------------------------------------------------------------------- */

describe('BR-02 an envelope has no field that can hold a message list', () => {
  it.each(['messages', 'history', 'conversation', 'chatHistory'])(
    'rejects a top-level `%s` key',
    (key) => {
      expect(EnvelopeSchema.safeParse({ ...envelope, [key]: [] }).success).toBe(false);
    },
  );

  it.each(['messages', 'history'])('rejects `%s` smuggled into context', (key) => {
    expect(
      EnvelopeSchema.safeParse({
        ...envelope,
        context: { ...envelope.context, [key]: [{ role: 'user', content: 'hi' }] },
      }).success,
    ).toBe(false);
  });

  it.each(['messages', 'history'])('rejects `%s` smuggled into the output contract', (key) => {
    expect(
      EnvelopeSchema.safeParse({ ...envelope, contract: { outputTypes: ['text'], [key]: [] } })
        .success,
    ).toBe(false);
  });

  it('declares no field whose name suggests a transcript', () => {
    const fields = Object.keys(EnvelopeSchema.shape);

    expect(fields).toEqual([
      'id',
      'runId',
      'fromNodeId',
      'toNodeId',
      'iteration',
      'reads',
      'context',
      'contract',
      'guardrailVerdicts',
      'createdAt',
    ]);
  });
});

describe('FR-EXE-005 Envelope', () => {
  it('accepts the minimum envelope Arch §12.4 defines', () => {
    expect(EnvelopeSchema.parse(envelope)).toEqual(envelope);
  });

  it('accepts a full context — summary, retrieved chunks and memory', () => {
    const full = {
      ...envelope,
      context: {
        summary: 'truncated to budget',
        retrieved: [{ chunkId: ARTIFACT_ID, text: 'a chunk', score: 0.82, source: 'brief.pdf' }],
        memory: [{ key: 'tone', value: 'formal' }],
        budgetTokens: 4000,
        trust: 'untrusted',
      },
    };

    expect(EnvelopeSchema.parse(full)).toEqual(full);
  });

  it('labels content trusted or untrusted and nothing else (BR-13)', () => {
    expect(
      EnvelopeSchema.parse({ ...envelope, context: { budgetTokens: 10, trust: 'trusted' } }).context
        .trust,
    ).toBe('trusted');
    expect(
      EnvelopeSchema.safeParse({ ...envelope, context: { budgetTokens: 10, trust: 'maybe' } })
        .success,
    ).toBe(false);
  });

  it('requires a budget, because context may never be unbounded (FR-EXE-007)', () => {
    expect(
      EnvelopeSchema.safeParse({ ...envelope, context: { trust: 'untrusted' } }).success,
    ).toBe(false);
    expect(
      EnvelopeSchema.safeParse({ ...envelope, context: { budgetTokens: 0, trust: 'untrusted' } })
        .success,
    ).toBe(false);
  });

  it('numbers iterations from 1', () => {
    expect(EnvelopeSchema.safeParse({ ...envelope, iteration: 0 }).success).toBe(false);
    expect(EnvelopeSchema.parse({ ...envelope, iteration: 3 }).iteration).toBe(3);
  });

  it('carries guardrail verdicts round 3 will type', () => {
    expect(EnvelopeSchema.parse({ ...envelope, guardrailVerdicts: [] }).guardrailVerdicts).toEqual(
      [],
    );
    expect(EnvelopeSchema.parse(envelope).guardrailVerdicts).toBeUndefined();
  });

  it('types them as Verdicts from round 3', () => {
    const verdict = {
      id: VERDICT_ID,
      nodeRunId: NODE_RUN_ID,
      point: 'input',
      checkType: 'prompt_injection',
      action: 'warn',
      passed: false,
      reason: 'The input asks the model to ignore its instructions.',
      at: NOW,
    };

    expect(
      EnvelopeSchema.parse({ ...envelope, guardrailVerdicts: [verdict] }).guardrailVerdicts,
    ).toEqual([verdict]);
    expect(
      EnvelopeSchema.safeParse({ ...envelope, guardrailVerdicts: [{ passed: true }] }).success,
    ).toBe(false);
  });

  it('refuses node ids and a run id that are not ULIDs', () => {
    expect(EnvelopeSchema.safeParse({ ...envelope, runId: 'run-1' }).success).toBe(false);
    expect(EnvelopeSchema.safeParse({ ...envelope, fromNodeId: 'node-a' }).success).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* validateAgainstContract — TC-EXE-005                                        */
/* -------------------------------------------------------------------------- */

const text = (value: string): Part => ({ type: 'text', text: value });
const json = (value: unknown): Part => ({ type: 'json', value });

describe('TC-EXE-005 validateAgainstContract — data types', () => {
  it('passes text output against a text contract', () => {
    expect(validateAgainstContract([text('hello')], { outputTypes: ['text'] })).toEqual({
      ok: true,
    });
  });

  it('fails text output against a json contract, naming both sides', () => {
    const result = validateAgainstContract([text('hello')], { outputTypes: ['json'] });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('text');
    expect(result.reason).toContain('json');
  });

  it('fails when the contract asks for two types and the output has one', () => {
    const result = validateAgainstContract([text('hello')], { outputTypes: ['text', 'json'] });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('json');
  });

  it('passes when every contracted type is produced', () => {
    expect(
      validateAgainstContract([text('hello'), json({ a: 1 })], { outputTypes: ['text', 'json'] }),
    ).toEqual({ ok: true });
  });

  it('fails on empty output', () => {
    const result = validateAgainstContract([], { outputTypes: ['text'] });

    expect(result.ok).toBe(false);
  });
});

describe('TC-EXE-005 validateAgainstContract — JSON schema', () => {
  const contract = {
    outputTypes: ['json' as const],
    jsonSchema: {
      type: 'object',
      required: ['verdict', 'score'],
      properties: {
        verdict: { type: 'string', enum: ['approved', 'changes_requested'] },
        score: { type: 'integer' },
        issues: { type: 'array', items: { type: 'string' } },
      },
    },
  };

  it('passes the shape the mock json model returns', () => {
    expect(
      validateAgainstContract([json({ verdict: 'approved', score: 8, issues: [] })], contract),
    ).toEqual({ ok: true });
  });

  it('fails when a required field is missing', () => {
    const result = validateAgainstContract([json({ verdict: 'approved' })], contract);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('score');
  });

  it('fails when a field has the wrong type', () => {
    const result = validateAgainstContract([json({ verdict: 'approved', score: 'high' })], contract);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('score');
  });

  it('fails when a value is outside the enum', () => {
    const result = validateAgainstContract([json({ verdict: 'perhaps', score: 8 })], contract);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('verdict');
  });

  it('fails when an array item has the wrong type', () => {
    const result = validateAgainstContract(
      [json({ verdict: 'approved', score: 8, issues: [{ note: 'x' }] })],
      contract,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('issues');
  });

  it('rejects an integer field given a fraction', () => {
    const result = validateAgainstContract([json({ verdict: 'approved', score: 8.5 })], contract);

    expect(result.ok).toBe(false);
  });

  it('honours additionalProperties: false', () => {
    const closed = {
      outputTypes: ['json' as const],
      jsonSchema: {
        type: 'object',
        properties: { a: { type: 'string' } },
        additionalProperties: false,
      },
    };
    const result = validateAgainstContract([json({ a: 'x', b: 'y' })], closed);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('b');
  });

  it('accepts any json when the contract names no schema', () => {
    expect(validateAgainstContract([json({ anything: true })], { outputTypes: ['json'] })).toEqual({
      ok: true,
    });
  });

  it('checks nested objects', () => {
    const nested = {
      outputTypes: ['json' as const],
      jsonSchema: {
        type: 'object',
        required: ['meta'],
        properties: {
          meta: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        },
      },
    };

    expect(validateAgainstContract([json({ meta: { id: 'x' } })], nested)).toEqual({ ok: true });
    expect(validateAgainstContract([json({ meta: { id: 7 } })], nested).ok).toBe(false);
  });

  it('pins a field to a single value with const', () => {
    const pinned = {
      outputTypes: ['json' as const],
      jsonSchema: { type: 'object', properties: { kind: { const: 'review' } } },
    };

    expect(validateAgainstContract([json({ kind: 'review' })], pinned)).toEqual({ ok: true });
    const result = validateAgainstContract([json({ kind: 'draft' })], pinned);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('kind');
  });

  it('accepts a list of allowed types, so a nullable field is expressible', () => {
    const nullable = {
      outputTypes: ['json' as const],
      jsonSchema: { type: 'object', properties: { note: { type: ['string', 'null'] } } },
    };

    expect(validateAgainstContract([json({ note: 'hi' })], nullable)).toEqual({ ok: true });
    expect(validateAgainstContract([json({ note: null })], nullable)).toEqual({ ok: true });
    expect(validateAgainstContract([json({ note: 7 })], nullable).ok).toBe(false);
  });

  it('names the keywords it understands, so a contract author knows the subset (D53, D74)', () => {
    expect([...SUPPORTED_JSON_SCHEMA_KEYWORDS]).toEqual([
      'type',
      'enum',
      'const',
      'required',
      'properties',
      'additionalProperties',
      'items',
      'minimum',
      'maximum',
    ]);
  });

  it('holds a number to its minimum and maximum, bounds included (D74)', () => {
    const bounded = {
      outputTypes: ['json' as const],
      jsonSchema: {
        type: 'object',
        properties: { score: { type: 'number', minimum: 0, maximum: 10 } },
      },
    };

    expect(validateAgainstContract([json({ score: 0 })], bounded)).toEqual({ ok: true });
    expect(validateAgainstContract([json({ score: 10 })], bounded)).toEqual({ ok: true });

    const low = validateAgainstContract([json({ score: -1 })], bounded);
    expect(low.ok).toBe(false);
    expect(low.ok ? '' : low.reason).toContain('"score" must be >= 0');

    const high = validateAgainstContract([json({ score: 11 })], bounded);
    expect(high.ok).toBe(false);
    expect(high.ok ? '' : high.reason).toContain('"score" must be <= 10');
  });

  it('applies the bounds to numbers only, as JSON Schema does', () => {
    const boundedOnly = { outputTypes: ['json' as const], jsonSchema: { minimum: 5 } };

    expect(validateAgainstContract([json('a string')], boundedOnly)).toEqual({ ok: true });
    expect(validateAgainstContract([json(4)], boundedOnly).ok).toBe(false);
  });

  it('never applies the json schema to a text part', () => {
    expect(
      validateAgainstContract([text('hello'), json({ verdict: 'approved', score: 1 })], {
        ...contract,
        outputTypes: ['text', 'json'],
      }),
    ).toEqual({ ok: true });
  });
});

/* -------------------------------------------------------------------------- */
/* Merge output — round 3 §2.4                                                 */
/* -------------------------------------------------------------------------- */

describe('FR-PAR-002 the merge node output', () => {
  const output = {
    inputs: [
      { port: `${NODE_C}:in:in`, nodeId: NODE_A, parts: [{ type: 'text', text: 'left branch' }] },
      {
        port: `${NODE_C}:in:in_json`,
        nodeId: NODE_B,
        parts: [{ type: 'json', value: { right: true } }],
      },
    ],
  };

  it('lists what each input port received and from which node, in order', () => {
    expect(MergeOutputSchema.parse(output)).toEqual(output);
  });

  it('names the port by its id, not its bare name', () => {
    const [first] = output.inputs;

    expect(MergeOutputSchema.safeParse({ inputs: [{ ...first, port: 'in' }] }).success).toBe(false);
  });

  it('names one of the merge node inputs, never an output port', () => {
    const [first] = output.inputs;

    expect(
      MergeOutputSchema.safeParse({ inputs: [{ ...first, port: `${NODE_C}:out:out` }] }).success,
    ).toBe(false);
  });

  it('carries parts, never loose text', () => {
    const [first] = output.inputs;

    expect(MergeOutputSchema.safeParse({ inputs: [{ ...first, parts: 'left' }] }).success).toBe(
      false,
    );
  });

  it('is strict, like every shape in this module', () => {
    expect(MergeOutputSchema.safeParse({ ...output, mode: 'all' }).success).toBe(false);
  });
});

describe('FR-EXE-006 the contract shape itself', () => {
  it('accepts output types, an optional schema and an optional token cap', () => {
    const contract = {
      outputTypes: ['json'],
      jsonSchema: { type: 'object' },
      maxTokens: 2048,
    };

    expect(EnvelopeContractSchema.parse(contract)).toEqual(contract);
  });

  it('refuses an empty output type list — a node must produce something', () => {
    expect(EnvelopeContractSchema.safeParse({ outputTypes: [] }).success).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Context, now filled (round 5 §2.2, §2.4)                                    */
/* -------------------------------------------------------------------------- */

describe('FR-RAG-005 FR-MEM-003 envelope context', () => {
  const chunk = { chunkId: KB_CHUNK_ID, text: 'The handshake.', score: 0.5, source: 'a.md#Intro' };

  it('carries retrieved chunks and remembered facts beside the summary', () => {
    const context = {
      summary: 'Earlier work, in brief.',
      retrieved: [chunk],
      memory: [{ key: 'user_name', value: 'Ada' }],
      budgetTokens: 4000,
      trust: 'untrusted',
    };
    expect(EnvelopeSchema.parse({ ...envelope, context }).context).toEqual(context);
  });

  it('bounds a retrieved score to 0..1, as the search hit it came from', () => {
    const withScore = (score: number) =>
      EnvelopeSchema.safeParse({
        ...envelope,
        context: { ...envelope.context, retrieved: [{ ...chunk, score }] },
      }).success;

    expect(withScore(0)).toBe(true);
    expect(withScore(1)).toBe(true);
    expect(withScore(1.2)).toBe(false);
  });

  it('refuses a stored memory row in place of a key and value (D229)', () => {
    expect(
      EnvelopeSchema.safeParse({
        ...envelope,
        context: {
          ...envelope.context,
          memory: [{ id: NODE_C, nodeId: NODE_A, key: 'k', value: 'v', createdAt: NOW }],
        },
      }).success,
    ).toBe(false);
  });

  it('gives retrieved chunks at most half the budget and memory a quarter (§2.2, §4 item 7)', () => {
    expect(CONTEXT_BUDGET_SHARES).toEqual({ retrieved: 0.5, memory: 0.25 });
    expect(Object.isFrozen(CONTEXT_BUDGET_SHARES)).toBe(true);
  });
});
