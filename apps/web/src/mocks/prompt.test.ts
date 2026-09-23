import { EnvelopeSchema } from '@ace/contracts';

import { newId } from '../lib/ulid';
import {
  SYSTEM_BASE_TEXT,
  UNTRUSTED_MARKER,
  assemblePrompt,
  buildEnvelope,
  promptVersion,
} from './prompt';

const contract = { outputTypes: ['text'] };

describe('FR-PRM-001 the mock assembles prompts in the §2.8 order', () => {
  it('keeps every header, in order, even when a section is empty this round', () => {
    const text = assemblePrompt({ instructions: 'Summarise.', reads: [], contract });
    const order = [
      '## System',
      '## Instructions',
      '## Skills',
      '## Guardrails',
      '## Context',
      '### Summary',
      '### Retrieved',
      '### Memory',
      '## Input',
      '## Output contract',
    ];
    let cursor = -1;
    for (const header of order) {
      const at = text.indexOf(header);
      expect(at, header).toBeGreaterThan(cursor);
      cursor = at;
    }
    expect(text).toContain(SYSTEM_BASE_TEXT);
    expect(text).toContain('Summarise.');
  });

  it('FR-PRM-002 labels every context section untrusted', () => {
    const text = assemblePrompt({ instructions: '', reads: [], contract });
    expect(text.split(UNTRUSTED_MARKER)).toHaveLength(4);
  });

  it('renders text, json and code reads the way the engine does', () => {
    const text = assemblePrompt({
      instructions: '',
      reads: [
        { type: 'text', text: 'plain' },
        { type: 'json', value: { a: 1 } },
        { type: 'code', language: 'ts', text: 'const a = 1;' },
      ],
      contract,
    });
    expect(text).toContain('plain');
    expect(text).toContain('"a": 1');
    expect(text).toContain('```ts');
  });

  it('names the output types and the JSON schema in the contract section', () => {
    const text = assemblePrompt({
      instructions: '',
      reads: [],
      contract: { outputTypes: ['json'], jsonSchema: { type: 'object' } },
    });
    expect(text).toContain('types: json');
    expect(text).toContain('"type":"object"');
  });
});

describe('FR-PRM-004 prompt.version is a stable function of its inputs', () => {
  it('is identical for the same instructions and contract', () => {
    expect(promptVersion('Summarise.', contract)).toBe(promptVersion('Summarise.', contract));
  });

  it('changes when the instructions change (TC-PRM-004)', () => {
    expect(promptVersion('Summarise.', contract)).not.toBe(promptVersion('Translate.', contract));
  });

  it('changes when the output contract changes', () => {
    expect(promptVersion('x', contract)).not.toBe(
      promptVersion('x', { outputTypes: ['json'], jsonSchema: { type: 'object' } }),
    );
  });

  it('is twelve hex characters, like the engine’s truncated sha256', () => {
    expect(promptVersion('x', contract)).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe('BR-02 the mock hands over envelopes, never history', () => {
  it('builds an envelope the contract accepts, with a bounded untrusted context', () => {
    const envelope = buildEnvelope({
      id: newId(),
      runId: newId(),
      fromNodeId: newId(),
      toNodeId: newId(),
      reads: [{ type: 'text', text: 'upstream output' }],
      budgetTokens: 4000,
      outputTypes: ['text'],
      createdAt: '2026-09-23T10:00:00.000Z',
    });
    expect(EnvelopeSchema.parse(envelope)).toBeTruthy();
    expect(envelope.context.trust).toBe('untrusted');
    expect(envelope.context.budgetTokens).toBe(4000);
    expect(envelope).not.toHaveProperty('messages');
  });
});
