import { createHash } from 'node:crypto';

import type { Envelope } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import {
  MEMORY_PROMPT_VERSION,
  SYSTEM_BASE_VERSION,
  assemblePrompt,
  promptVersion,
  type PromptSkill,
} from '../prompts/index.js';

/**
 * D272, FR-PRM-001, TC-PRM-004: an agent's skills render under `## Skills`, and the prompt version
 * covers them — while every prompt without skills keeps exactly the version it had before.
 */

const NOW = '2026-10-07T10:00:00.000Z';

const envelope: Envelope = {
  id: '01JBXQ8Z9KQ4R7N2VWXYZ0ENVP',
  runId: '01JBXQ8Z9KQ4R7N2VWXYZ0RN55',
  fromNodeId: '01JBXQ8Z9KQ4R7N2VWXYZ0ABCD',
  toNodeId: '01JBXQ8Z9KQ4R7N2VWXYZ0EFGH',
  iteration: 1,
  reads: [{ type: 'text', text: 'the brief text' }],
  context: { budgetTokens: 4000, trust: 'untrusted' },
  contract: { outputTypes: ['text'] },
  createdAt: NOW,
};

const INSTRUCTIONS = 'Summarise the brief in one paragraph.';

const assemble = (overrides: Partial<Parameters<typeof assemblePrompt>[0]> = {}) =>
  assemblePrompt({
    instructions: INSTRUCTIONS,
    envelopes: [envelope],
    contract: { outputTypes: ['text'] },
    iteration: 1,
    ...overrides,
  });

const testFirst: PromptSkill = {
  name: 'Test first',
  version: 1,
  instructions: 'Write a failing test.\nThen make it pass.',
};
const explain: PromptSkill = {
  name: 'Explain the change',
  version: 2,
  instructions: 'Summarise what changed and why.',
};

/** The text between one section header and the next. */
function section(text: string, header: string, next: string): string {
  return text.slice(text.indexOf(header) + header.length, text.indexOf(next)).trim();
}

describe('D272 skills render under ## Skills', () => {
  it('renders each skill as ### <name> and its instructions, in the order given', () => {
    const { text } = assemble({ skills: [testFirst, explain] });
    expect(section(text, '## Skills', '## Guardrails')).toBe(
      [
        '### Test first',
        'Write a failing test.',
        'Then make it pass.',
        '',
        '### Explain the change',
        'Summarise what changed and why.',
      ].join('\n'),
    );
    // Skills are instructions the user installed: they sit beside the agent's own, never inside
    // the untrusted blocks.
    expect(section(text, '## Instructions', '## Skills')).toBe(INSTRUCTIONS);
  });

  it('leaves the section empty — and the whole prompt byte-identical — without skills', () => {
    const plain = assemble();
    expect(section(plain.text, '## Skills', '## Guardrails')).toBe('');
    expect(assemble({ skills: [] })).toEqual(plain);
  });

  it('masks a credential-shaped string in a skill in the stored prompt (FR-PRM-005)', () => {
    const key = ['sk', '-', 'a1B2'.repeat(8)].join('');
    const { text, redactedText } = assemble({
      skills: [{ ...testFirst, instructions: `Use ${key}.` }],
    });
    expect(text).toContain(key);
    expect(redactedText).not.toContain(key);
  });
});

describe('TC-PRM-004 D272 the prompt version covers the skills, and only when there are any', () => {
  it('keeps the version every existing prompt had: the pre-skills formula, unchanged', () => {
    const before = createHash('sha256')
      .update(SYSTEM_BASE_VERSION)
      .update('\u0000')
      .update(INSTRUCTIONS)
      .update('\u0000')
      .update('{"outputTypes":["text"]}')
      .digest('hex')
      .slice(0, 12);
    expect(assemble().version).toBe(before);
    expect(assemble({ skills: [] }).version).toBe(before);
    expect(promptVersion(SYSTEM_BASE_VERSION, INSTRUCTIONS, { outputTypes: ['text'] })).toBe(
      before,
    );
    expect(
      promptVersion(SYSTEM_BASE_VERSION, INSTRUCTIONS, { outputTypes: ['text'] }, undefined, []),
    ).toBe(before);
  });

  it('changes when a skill is added, renamed, re-versioned or reordered — not for its text alone', () => {
    const base = assemble().version;
    const one = assemble({ skills: [testFirst] }).version;
    expect(one).not.toBe(base);
    expect(one).toMatch(/^[0-9a-f]{12}$/);

    expect(assemble({ skills: [{ ...testFirst, version: 2 }] }).version).not.toBe(one);
    expect(assemble({ skills: [{ ...testFirst, name: 'Tests first' }] }).version).not.toBe(one);
    expect(assemble({ skills: [testFirst, explain] }).version).not.toBe(
      assemble({ skills: [explain, testFirst] }).version,
    );
    // The version names the configuration: a skill's version moves whenever its text does.
    expect(assemble({ skills: [{ ...testFirst, instructions: 'Other.' }] }).version).toBe(one);
  });

  it('is stable for the same skills, and folds in beside the memory block', () => {
    expect(assemble({ skills: [testFirst] }).version).toBe(
      assemble({ skills: [testFirst] }).version,
    );
    const withMemory = assemble({
      skills: [testFirst],
      memoryInstructions: true,
      contract: { outputTypes: ['json'] },
    }).version;
    expect(withMemory).toBe(
      promptVersion(
        SYSTEM_BASE_VERSION,
        INSTRUCTIONS,
        { outputTypes: ['json'] },
        MEMORY_PROMPT_VERSION,
        [testFirst],
      ),
    );
    expect(withMemory).not.toBe(
      assemble({ memoryInstructions: true, contract: { outputTypes: ['json'] } }).version,
    );
  });
});
