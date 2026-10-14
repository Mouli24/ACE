import { describe, expect, it } from 'vitest';

import { estimateCallTokens, projectRound } from '../budget.js';
import { lastJsonBlock } from '../contract.js';
import {
  judgePrompt,
  openingPrompt,
  rebuttalPrompt,
  repairPrompt,
  shownReasoning,
} from '../prompts.js';

describe('lastJsonBlock takes the last fenced json block (the brief’s parsing rule)', () => {
  it('takes the last of several blocks', () => {
    const text = 'first\n```json\n{"a":1}\n```\nthen\n```json\n{"a":2}\n```\n';
    expect(lastJsonBlock(text)).toEqual({ ok: true, value: { a: 2 } });
  });

  it('accepts JSON in upper case and a fence with no trailing newline', () => {
    expect(lastJsonBlock('```JSON\n{"a":3}```')).toEqual({ ok: true, value: { a: 3 } });
  });

  it('a missing block is an error the repair prompt can name', () => {
    expect(lastJsonBlock('{"a":1}')).toEqual({
      ok: false,
      error: 'no fenced json block was found',
    });
  });

  it('a block that does not parse is an error', () => {
    const result = lastJsonBlock('```json\n{"a":\n```');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/^the json block does not parse/);
  });
});

describe('D343 the prompt templates', () => {
  const format = { answerFormat: 'choice' as const, options: ['yes', 'no'] };

  it('opening: label, stance, question, material, reads, instructions, answer line, json shape', () => {
    const prompt = openingPrompt({
      label: 'B',
      stance: 'against',
      topic: 'Use Redis?',
      material: 'Three instances.',
      reads: [{ path: 'a.ts', content: 'const a = 1;' }],
      instructions: ['Be brief.'],
      format,
    });
    expect(prompt).toBe(
      [
        'You are debater B in a structured debate. Other debaters are answering the same question on their own. You will see their answers next round.',
        'Your assigned stance: against. Argue it honestly. If the evidence defeats it, say so.',
        'QUESTION:',
        'Use Redis?',
        'MATERIAL:',
        'Three instances.',
        '--- a.ts ---',
        'const a = 1;',
        'INSTRUCTIONS FROM THE HUMAN TO YOU: Be brief.',
        'Answer: exactly one of: "yes", "no"',
        'End with one fenced json block:',
        '{"answer": "...", "confidence": 0.0, "reasoning": "..."}',
      ].join('\n'),
    );
  });

  it('opening without stance, material, reads or instructions', () => {
    const prompt = openingPrompt({
      label: 'A',
      topic: 'Q?',
      material: '',
      reads: [],
      instructions: [],
      format: { answerFormat: 'free' },
    });
    expect(prompt).not.toContain('stance');
    expect(prompt).not.toContain('INSTRUCTIONS');
    expect(prompt).toContain('MATERIAL:\n(none)');
    expect(prompt).toContain('Answer: a direct answer to the question');
  });

  it('rebuttal: round, the rules, last round with the own turn marked', () => {
    const turn = (label: 'A' | 'B') => ({
      turnId: `R0-${label}`,
      round: 0,
      label,
      answer: 'yes',
      confidence: 0.5,
      reasoning: `why ${label}`,
      rebuttals: [],
      positionChanged: false,
      changedBecause: null,
    });
    const prompt = rebuttalPrompt({
      label: 'A',
      round: 1,
      maxRounds: 2,
      topic: 'Q?',
      material: 'M',
      reads: [],
      instructions: [],
      format,
      lastRound: [
        { turnId: 'R0-A', mine: true, turn: turn('A') },
        { turnId: 'R0-B', mine: false, turn: turn('B') },
        { turnId: 'R0-C', mine: false },
      ],
    });
    expect(prompt).toContain('You are debater A in a structured debate.');
    expect(prompt).toContain(
      "Round 1 of 2. Below are last round's turns: yours and the other debaters'.",
    );
    expect(prompt).toContain('- "Most debaters agree" is not a reason to change.');
    expect(prompt).toContain(
      'LAST ROUND:\n[R0-A] (you) yes | 0.5 | why A\n[R0-B] yes | 0.5 | why B\n[R0-C] (no valid turn this round)',
    );
    expect(prompt).toContain('"positionChanged": false, "changedBecause": null}');
  });

  it('judge: final round in full, earlier rounds compact, citation rules', () => {
    const r0 = {
      turnId: 'R0-A',
      round: 0,
      label: 'A' as const,
      answer: 'no',
      confidence: 0.4,
      reasoning: 'early',
      rebuttals: [],
      positionChanged: false,
      changedBecause: null,
    };
    const r1 = {
      ...r0,
      turnId: 'R1-A',
      round: 1,
      answer: 'yes',
      reasoning: 'late',
      rebuttals: [{ targetTurnId: 'R0-B', claim: 'too slow', response: 'it is fast' }],
      positionChanged: true,
      changedBecause: { turnId: 'R0-B', argument: 'the benchmark' },
    };
    const prompt = judgePrompt({
      topic: 'Q?',
      material: 'M',
      instructions: ['Prefer cheap.'],
      format,
      final: [r1],
      earlier: [r0],
    });
    expect(prompt).toContain(
      'Pick the best answer from the arguments, not from how many debaters hold it.',
    );
    expect(prompt).toContain('If you add a point no debater made, cite "judge".');
    expect(prompt).toContain('INSTRUCTIONS FROM THE HUMAN TO YOU: Prefer cheap.');
    expect(prompt).toContain(
      'FINAL ROUND (full):\n[R1-A] yes | 0.4 | late\n  rebuts R0-B: "too slow" → it is fast\n  changed because of R0-B: the benchmark',
    );
    expect(prompt).toContain(
      'EARLIER ROUNDS (compact):\n[R0-A] no | 0.4 | changed: no | rebuttals: none',
    );
    expect(prompt).toContain(
      '"dissent": [{"label": "B", "answer": "...", "strongestArgument": "...", "turnId": "R2-B"}]',
    );
  });

  it('judge over the openings alone has no earlier rounds section', () => {
    const prompt = judgePrompt({
      topic: 'Q?',
      material: 'M',
      instructions: [],
      format,
      final: [],
      earlier: [],
    });
    expect(prompt).not.toContain('EARLIER ROUNDS');
  });

  it('repair: the original prompt, the reply, then the errors', () => {
    expect(repairPrompt('PROMPT', 'REPLY', ['a', 'b'])).toBe(
      "PROMPT\n\nYOUR LAST REPLY:\nREPLY\n\nYour last reply didn't meet the required format: a; b. Reply again with only the corrected fenced json block.",
    );
  });

  it('shows at most 6000 characters of reasoning, marked when cut', () => {
    expect(shownReasoning('short')).toBe('short');
    expect(shownReasoning('x'.repeat(6000))).toBe('x'.repeat(6000));
    expect(shownReasoning('x'.repeat(6001))).toBe(`${'x'.repeat(6000)} [truncated]`);
  });
});

describe('D354 the round estimate', () => {
  it('a call is its prompt in characters ÷ 4 plus its expected output', () => {
    expect(estimateCallTokens('x'.repeat(400), 50)).toBe(150);
    expect(estimateCallTokens('x'.repeat(401), 0)).toBe(101);
  });

  it('a round is every turn plus the judge (and the baseline judge), in tokens and in USD', () => {
    const projection = projectRound(
      [
        { nodeId: 'a', prompt: 'x'.repeat(40), output: 10 },
        { nodeId: 'b', prompt: 'x'.repeat(80), output: 20 },
        { nodeId: 'hub', prompt: 'x'.repeat(120), output: 30 },
      ],
      (nodeId, tokensIn, tokensOut) =>
        nodeId === 'hub' ? undefined : (tokensIn + tokensOut) / 100,
    );
    expect(projection.tokens).toBe(10 + 10 + 20 + 20 + 30 + 30);
    // The hub has no price, so it adds nothing to the USD projection.
    expect(projection.usd).toBeCloseTo(0.2 + 0.4);
  });
});
