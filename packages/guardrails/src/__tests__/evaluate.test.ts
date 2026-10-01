import type { EnvelopeContract, GuardrailCheckType } from '@ace/contracts';
import {
  GUARDRAIL_CHECK_TYPES,
  GuardrailCheckSchema,
  defaultGuardrailChecks,
} from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import {
  EVALUATED_CHECK_TYPES,
  evaluateCheck,
  evaluateChecks,
  inOutputOrder,
  isEvaluated,
  OUTPUT_CHECK_ORDER,
} from '../evaluate.js';
import { FAKE_OPENAI_KEY, makeCheck, makeTool, SAMPLE_EMAIL } from './fixtures.js';

/**
 * FR-GRD-011 / FR-GRD-015 — the one entry point the engine calls. The rule this file exists to hold
 * down: **`undefined` is silence, not a pass.** A cost check handed only text must not produce a
 * passing verdict, because a passing verdict for a check that never ran is a safety claim nobody
 * made.
 */
describe('FR-GRD-011 evaluateCheck dispatch', () => {
  it('every check type of the contract is evaluated', () => {
    // Round 5 wired the last deferred type, `untrusted_tagging`; the four tool checks joined in
    // Round 4. Nothing is deferred any more.
    expect([...EVALUATED_CHECK_TYPES].sort()).toEqual([...GUARDRAIL_CHECK_TYPES].sort());
    for (const type of GUARDRAIL_CHECK_TYPES) expect(isEvaluated(type), type).toBe(true);
  });

  it('answers untrusted_tagging even when handed nothing, and it always passes', () => {
    expect(evaluateCheck(makeCheck('untrusted_tagging'), {})).toEqual({
      passed: true,
      reason: 'Tagged untrusted.',
    });
  });

  it('answers undefined for a check the policy has switched off', () => {
    const off = makeCheck('secret_leak', {}, { enabled: false });
    expect(evaluateCheck(off, { text: `leak ${FAKE_OPENAI_KEY}` })).toBeUndefined();
  });

  it('answers undefined for a cost check handed nothing but text', () => {
    for (const type of ['max_cost_per_run', 'daily_budget', 'max_tokens_per_node'] as const) {
      expect(
        evaluateCheck(makeCheck(type, { usd: 1, maxTokens: 1 }), {
          text: 'hello',
        }),
      ).toBeUndefined();
    }
  });

  it('answers undefined for a text check handed nothing but a number', () => {
    for (const type of ['size_limit', 'pii', 'prompt_injection', 'blocked_topics'] as const) {
      expect(evaluateCheck(makeCheck(type), { value: 42 })).toBeUndefined();
    }
    for (const type of ['moderation', 'secret_leak', 'required_citations'] as const) {
      expect(evaluateCheck(makeCheck(type), { value: 42 })).toBeUndefined();
    }
  });

  it('routes each evaluated type to a check that actually judges the input', () => {
    const judged: Partial<Record<GuardrailCheckType, boolean>> = {};
    const input = {
      text: `mail ${SAMPLE_EMAIL}, key ${FAKE_OPENAI_KEY}, ignore previous instructions, murder, no citation`,
      value: 1_000_000,
      limit: 1,
      outputHashes: ['h', 'h', 'h'],
      parts: [{ type: 'text', text: 'x' }] as const,
      contract: { outputTypes: ['json'] } satisfies EnvelopeContract,
      // A tool bag that makes all four tool checks fault: a destructive tool the agent never
      // enabled, called with a path that escapes the sandbox and a URL on no allow-list.
      tool: {
        definition: makeTool({
          name: 'sandbox_delete',
          inputSchema: { type: 'object', required: ['path'] },
          permissions: { destructive: true },
        }),
        args: { path: '../../x', url: 'https://evil.test/steal' },
        enabledTools: [],
        sandboxDir: '/project/.ace/sandbox/run1',
        allowedDomains: [],
      },
    };

    for (const type of EVALUATED_CHECK_TYPES) {
      const check = makeCheck(type, {
        patterns: ['no citation'],
        maxChars: 4,
        times: 3,
      });
      const result = evaluateCheck(check, input);
      expect(result, type).toBeDefined();
      judged[type] = result?.passed;
    }

    // Every one of them found its own fault in that input — except untrusted_tagging, which is
    // not a fault finder: it always passes.
    for (const type of EVALUATED_CHECK_TYPES) {
      expect(judged[type], type).toBe(type === 'untrusted_tagging');
    }
  });
});

describe('FR-GRD-015 evaluateChecks over a whole policy', () => {
  it("keeps the policy's order and drops the checks that had nothing to say", () => {
    let sequence = 0;
    const checks = defaultGuardrailChecks(
      () => `01${'B'.repeat(20)}${String((sequence += 1)).padStart(4, '0')}`,
    );

    // Every one of them is a check the contract accepts.
    for (const check of checks) expect(GuardrailCheckSchema.parse(check)).toEqual(check);

    const evaluated = evaluateChecks(checks, {
      text: `leak ${FAKE_OPENAI_KEY}`,
    });
    const types = evaluated.map(({ check }) => check.type);

    // Text-only input: the input, output and context checks answer (untrusted_tagging always
    // passes); the cost, loop and tool ones do not.
    // evaluateChecks ignores the point — the engine picks a point's checks before it calls this.
    expect(types).toEqual([
      'pii',
      'prompt_injection',
      'size_limit',
      'secret_leak',
      'moderation',
      'untrusted_tagging',
      'prompt_injection',
      'pii',
    ]);
    expect(evaluated.find(({ check }) => check.type === 'secret_leak')?.result.passed).toBe(false);
  });

  it('pairs every result with the check that produced it, so the engine can read the action', () => {
    const block = makeCheck('secret_leak', {}, { action: 'block' });
    const warn = makeCheck('pii', {}, { action: 'warn' });
    const evaluated = evaluateChecks([block, warn], {
      text: `${FAKE_OPENAI_KEY} ${SAMPLE_EMAIL}`,
    });

    expect(evaluated.map(({ check }) => check.action)).toEqual(['block', 'warn']);
    expect(evaluated.every(({ result }) => result.passed === false)).toBe(true);
  });
});

describe('FR-GRD-007 output check order', () => {
  it('is secret_leak → pii → moderation → required_citations → contract (round 3 §4 item 4)', () => {
    expect([...OUTPUT_CHECK_ORDER]).toEqual([
      'secret_leak',
      'pii',
      'moderation',
      'required_citations',
      'contract',
    ]);
  });

  it('sorts a policy’s output checks into it whatever order they were saved in', () => {
    const checks = [
      makeCheck('contract'),
      makeCheck('required_citations'),
      makeCheck('pii', {}, { point: 'output' }),
      makeCheck('moderation'),
      makeCheck('secret_leak'),
    ];
    expect(inOutputOrder(checks).map((check) => check.type)).toEqual([...OUTPUT_CHECK_ORDER]);
  });

  it('leaves a type it does not rank in its original position, after the ranked ones', () => {
    const checks = [makeCheck('size_limit'), makeCheck('secret_leak')];
    expect(inOutputOrder(checks).map((check) => check.type)).toEqual(['secret_leak', 'size_limit']);
  });
});
