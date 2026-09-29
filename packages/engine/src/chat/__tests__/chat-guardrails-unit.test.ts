import type { Part } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { check, fakeChecks, fakeMasker, fakeOpenAiKey, policy as makePolicy } from '../../guardrails/__tests__/fakes.js';
import { evaluateChatInput, evaluateChatReply, type ChatGuardrailDeps } from '../guardrails.js';

/**
 * The pure chat-guardrail evaluators (FR-CHAT-008, FR-GRD-011, D86), tested without the service:
 * the output-point ordering fallback (a check absent from the fixed order sorts last) and the
 * `secret_leak` block that runs before the data mask (TC-GRD-010).
 */
describe('chat guardrail evaluators', () => {
  let counter = 0;
  const deps: ChatGuardrailDeps = {
    checks: fakeChecks,
    masker: fakeMasker,
    now: () => '2026-09-30T10:00:00.000Z',
    nextId: () => `verdict-${counter++}`,
  };

  const parts = (text: string): Part[] => [{ type: 'text', text }];

  it('ranks output checks by the fixed order, sorting an unlisted check last', () => {
    // `blocked_topics` is not in OUTPUT_CHECK_ORDER, `moderation`/`pii`/`required_citations` are, so
    // the sort comparator sees both the "in order" and the "not in order" (`-1`) sides.
    const policy = makePolicy({
      checks: [
        check({ point: 'output', type: 'blocked_topics', action: 'warn', params: { patterns: ['zzz'] } }),
        check({ point: 'output', type: 'required_citations', action: 'warn' }),
        check({ point: 'output', type: 'moderation', action: 'warn' }),
        check({ point: 'output', type: 'pii', action: 'warn' }),
      ],
    });

    const result = evaluateChatReply(policy, parts('a plain sentence with nothing to flag'), deps);
    expect(result.kind).toBe('ok');
    // required_citations fails (no citation), so at least one verdict is recorded; nothing blocks.
    expect(result.verdicts.some((v) => v.checkType === 'required_citations')).toBe(true);
  });

  it('ranks output checks when an unlisted check sits last as well as first', () => {
    // The mirror of the case above: here the unlisted `blocked_topics` is last, so the sort
    // comparator meets it as its right-hand operand too (the other `-1` branch).
    const policy = makePolicy({
      checks: [
        check({ point: 'output', type: 'pii', action: 'warn' }),
        check({ point: 'output', type: 'moderation', action: 'warn' }),
        check({ point: 'output', type: 'blocked_topics', action: 'warn', params: { patterns: ['zzz'] } }),
      ],
    });

    const result = evaluateChatReply(policy, parts('an ordinary sentence'), deps);
    expect(result.kind).toBe('ok');
  });

  it('a secret_leak block at the output point stops the reply before masking', () => {
    const policy = makePolicy({
      checks: [check({ point: 'output', type: 'secret_leak', action: 'block' })],
    });

    const result = evaluateChatReply(policy, parts(`the key is ${fakeOpenAiKey()}`), deps);
    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') {
      expect(result.verdicts.some((v) => v.checkType === 'secret_leak')).toBe(true);
    }
  });

  it('a secret_leak warn records a verdict but lets the reply flow on to the mask', () => {
    // action `warn`: the leak check triggers (passed:false) but does not block, so the reply flows
    // past the leak step to the data mask, which redacts the key regardless (D86).
    const policy = makePolicy({
      checks: [check({ point: 'output', type: 'secret_leak', action: 'warn' })],
    });

    const result = evaluateChatReply(policy, parts(`token ${fakeOpenAiKey()}`), deps);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      const text = result.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
      expect(text).toContain('[api_key redacted]');
      expect(result.verdicts.filter((v) => v.checkType === 'secret_leak').length).toBeGreaterThan(0);
    }
  });

  it('a null policy at the output still runs the unconditional data mask', () => {
    const result = evaluateChatReply(null, parts(`leak ${fakeOpenAiKey()}`), deps);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      const text = result.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
      expect(text).toContain('[api_key redacted]');
      expect(result.verdicts.some((v) => v.point === 'data')).toBe(true);
    }
  });

  it('a null policy at the input passes the parts through untouched', () => {
    const result = evaluateChatInput(null, parts('hello there'), deps);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.parts).toEqual(parts('hello there'));
      expect(result.verdicts).toHaveLength(0);
    }
  });
});
