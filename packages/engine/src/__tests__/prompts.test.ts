import type { Envelope, Part } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import {
  CONVERSATION_SECTION,
  PROMPT_SECTIONS,
  SYSTEM_BASE_TEXT,
  SYSTEM_BASE_VERSION,
  UNTRUSTED_LABEL,
  assemblePrompt,
  findUnknownPlaceholders,
  promptVersion,
  resolvePlaceholders,
} from '../prompts/index.js';

const NOW = '2026-09-22T10:00:00.000Z';
const RUN_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0RN55';
const NODE_A = '01JBXQ8Z9KQ4R7N2VWXYZ0ABCD';
const NODE_B = '01JBXQ8Z9KQ4R7N2VWXYZ0EFGH';
const ARTIFACT = '01JBXQ8Z9KQ4R7N2VWXYZ0ARTF';

const envelope = (reads: Part[], overrides: Partial<Envelope> = {}): Envelope => ({
  id: '01JBXQ8Z9KQ4R7N2VWXYZ0ENVP',
  runId: RUN_ID,
  fromNodeId: NODE_A,
  toNodeId: NODE_B,
  iteration: 1,
  reads,
  context: { budgetTokens: 4000, trust: 'untrusted' },
  contract: { outputTypes: ['text'] },
  createdAt: NOW,
  ...overrides,
});

const assemble = (overrides: Partial<Parameters<typeof assemblePrompt>[0]> = {}) =>
  assemblePrompt({
    instructions: 'Summarise the brief in one paragraph.',
    envelopes: [envelope([{ type: 'text', text: 'the brief text' }])],
    contract: { outputTypes: ['text'] },
    iteration: 1,
    ...overrides,
  });

/* -------------------------------------------------------------------------- */
/* Section order                                                               */
/* -------------------------------------------------------------------------- */

describe('TC-PRM-001 the prompt is assembled in one fixed order', () => {
  it('declares the §2.8 sections in the §2.8 order', () => {
    expect([...PROMPT_SECTIONS]).toEqual([
      '## System',
      '## Instructions',
      '## Skills',
      '## Guardrails',
      '## Context',
      '## Input',
      '## Output contract',
    ]);
  });

  it('emits every section header, in order, even when the section is empty', () => {
    const lines = assemble().text.split('\n');
    const headers = lines.filter((line) => (PROMPT_SECTIONS as readonly string[]).includes(line));

    expect(headers).toEqual([...PROMPT_SECTIONS]);
  });

  it('starts with the system base, which is a versioned constant', () => {
    expect(assemble().text.startsWith('## System\n')).toBe(true);
    expect(assemble().text).toContain(SYSTEM_BASE_TEXT);
    expect(SYSTEM_BASE_VERSION).toBeTruthy();
  });

  it('carries the agent instructions under Instructions', () => {
    const { text } = assemble({ instructions: 'Be terse.' });
    const instructions = text.slice(text.indexOf('## Instructions'), text.indexOf('## Skills'));

    expect(instructions).toContain('Be terse.');
  });

  it('is byte-identical for the same input, twice', () => {
    expect(assemble().text).toBe(assemble().text);
  });

  it('changes when the instructions change', () => {
    expect(assemble({ instructions: 'One.' }).text).not.toBe(
      assemble({ instructions: 'Two.' }).text,
    );
  });

  it('orders envelopes by their source node, so two arrivals cannot reorder the prompt', () => {
    const forwards = assemble({
      envelopes: [
        envelope([{ type: 'text', text: 'from A' }], { fromNodeId: NODE_A }),
        envelope([{ type: 'text', text: 'from B' }], { fromNodeId: NODE_B }),
      ],
    });
    const backwards = assemble({
      envelopes: [
        envelope([{ type: 'text', text: 'from B' }], { fromNodeId: NODE_B }),
        envelope([{ type: 'text', text: 'from A' }], { fromNodeId: NODE_A }),
      ],
    });

    expect(forwards.text).toBe(backwards.text);
    expect(forwards.text.indexOf('from A')).toBeLessThan(forwards.text.indexOf('from B'));
  });
});

/* -------------------------------------------------------------------------- */
/* Input rendering                                                             */
/* -------------------------------------------------------------------------- */

describe('FR-PRM-001 reads are rendered by their part type', () => {
  const inputOf = (parts: Part[]): string => {
    const { text } = assemble({ envelopes: [envelope(parts)] });
    return text.slice(text.indexOf('## Input'), text.indexOf('## Output contract'));
  };

  it('renders text as itself', () => {
    expect(inputOf([{ type: 'text', text: 'plain words' }])).toContain('plain words');
  });

  it('renders json in a fenced json block', () => {
    const rendered = inputOf([{ type: 'json', value: { a: 1 } }]);

    expect(rendered).toContain('```json');
    expect(rendered).toContain('"a": 1');
  });

  it('renders code in a fence labelled with its language', () => {
    const rendered = inputOf([{ type: 'code', language: 'ts', text: 'const a = 1;' }]);

    expect(rendered).toContain('```ts');
    expect(rendered).toContain('const a = 1;');
  });

  it('D6/FR-MM-004 renders a file as its full reference, never as bytes', () => {
    const rendered = inputOf([
      { type: 'file', artifactId: ARTIFACT, mime: 'application/pdf', name: 'brief.pdf', size: 12 },
    ]);

    expect(rendered).toContain('[file brief.pdf (12 bytes, application/pdf)]');
    expect(rendered).not.toContain(ARTIFACT);
  });

  it.each(['image', 'audio', 'video'] as const)(
    'renders a %s as name, size and mime for a vision model',
    (type) => {
      const rendered = inputOf([
        { type, artifactId: ARTIFACT, mime: 'image/png', name: 'diagram.png', size: 34 },
      ]);

      expect(rendered).toContain(`[${type} diagram.png (34 bytes, image/png)]`);
      expect(rendered).not.toContain(ARTIFACT);
    },
  );
});

/* -------------------------------------------------------------------------- */
/* Untrusted context                                                           */
/* -------------------------------------------------------------------------- */

describe('TC-PRM-002 / BR-13 untrusted content is labelled', () => {
  const withContext = () =>
    assemble({
      envelopes: [
        envelope([{ type: 'text', text: 'the brief' }], {
          context: {
            summary: 'a summary of earlier work',
            retrieved: [
              { chunkId: ARTIFACT, text: 'a retrieved chunk', score: 0.9, source: 'brief.pdf' },
            ],
            memory: [{ key: 'tone', value: 'formal' }],
            budgetTokens: 4000,
            trust: 'untrusted',
          },
        }),
      ],
    });

  it('emits the three context subsections §2.8 names', () => {
    const { text } = withContext();

    expect(text).toContain('### Summary');
    expect(text).toContain('### Retrieved');
    expect(text).toContain('### Memory');
  });

  it('labels each one untrusted', () => {
    const { text } = withContext();
    const context = text.slice(text.indexOf('## Context'), text.indexOf('## Input'));
    const labels = context.split(UNTRUSTED_LABEL).length - 1;

    expect(labels).toBe(3);
  });

  it('labels reads that came from a model too (BR-13)', () => {
    const { text } = assemble();
    const input = text.slice(text.indexOf('## Input'), text.indexOf('## Output contract'));

    expect(input).toContain(UNTRUSTED_LABEL);
  });

  it('does not label reads that came from an Input node', () => {
    const { text } = assemble({
      envelopes: [
        envelope([{ type: 'text', text: 'what the user typed' }], {
          context: { budgetTokens: 4000, trust: 'trusted' },
        }),
      ],
    });
    const input = text.slice(text.indexOf('## Input'), text.indexOf('## Output contract'));

    expect(input).not.toContain(UNTRUSTED_LABEL);
  });

  it('keeps the Context header even when there is no context', () => {
    expect(assemble().text).toContain('## Context');
  });
});

/* -------------------------------------------------------------------------- */
/* Output contract                                                             */
/* -------------------------------------------------------------------------- */

describe('FR-EXE-006 the prompt states the output contract', () => {
  it('names the types the node must produce', () => {
    const { text } = assemble({ contract: { outputTypes: ['json'] } });

    expect(text.slice(text.indexOf('## Output contract'))).toContain('json');
  });

  it('includes the JSON schema when there is one', () => {
    const { text } = assemble({
      contract: { outputTypes: ['json'], jsonSchema: { type: 'object', required: ['verdict'] } },
    });

    expect(text).toContain('"verdict"');
  });
});

/* -------------------------------------------------------------------------- */
/* Placeholders                                                                */
/* -------------------------------------------------------------------------- */

describe('FR-PRM-003 placeholders are resolved at assembly', () => {
  it('resolves {{input.text}} to the text reads', () => {
    const { text } = assemble({ instructions: 'Rewrite this: {{input.text}}' });

    expect(text).toContain('Rewrite this: the brief text');
    expect(text).not.toContain('{{input.text}}');
  });

  it('resolves {{run.iteration}}', () => {
    expect(assemble({ instructions: 'Pass {{run.iteration}}.', iteration: 3 }).text).toContain(
      'Pass 3.',
    );
  });

  it('resolves {{memory.<key>}}', () => {
    const { text } = assemble({
      instructions: 'Use a {{memory.tone}} tone.',
      memory: { tone: 'formal' },
    });

    expect(text).toContain('Use a formal tone.');
  });

  it('leaves an unknown placeholder in place rather than silently blanking it', () => {
    expect(resolvePlaceholders('{{foo.bar}}', { inputText: '', iteration: 1, memory: {} })).toBe(
      '{{foo.bar}}',
    );
  });

  it('TC-PRM-003 reports an unknown placeholder so validation can flag it', () => {
    expect(findUnknownPlaceholders('Use {{foo.bar}} and {{input.text}}', ['tone'])).toEqual([
      'foo.bar',
    ]);
  });

  it('accepts every placeholder §2.8 defines', () => {
    expect(
      findUnknownPlaceholders('{{input.text}} {{run.iteration}} {{memory.tone}}', ['tone']),
    ).toEqual([]);
  });

  it('reports a memory key the node has not declared', () => {
    expect(findUnknownPlaceholders('{{memory.unknown}}', ['tone'])).toEqual(['memory.unknown']);
  });

  it('reports each unknown placeholder once', () => {
    expect(findUnknownPlaceholders('{{a.b}} {{a.b}}', [])).toEqual(['a.b']);
  });
});

/* -------------------------------------------------------------------------- */
/* Version                                                                     */
/* -------------------------------------------------------------------------- */

describe('TC-PRM-004 the prompt version identifies what produced it', () => {
  it('is twelve hex characters', () => {
    expect(assemble().version).toMatch(/^[0-9a-f]{12}$/);
  });

  it('is the same for the same system base, instructions and contract', () => {
    expect(assemble().version).toBe(assemble().version);
  });

  it('changes when the instructions change', () => {
    expect(assemble({ instructions: 'One.' }).version).not.toBe(
      assemble({ instructions: 'Two.' }).version,
    );
  });

  it('changes when the output contract changes', () => {
    expect(assemble({ contract: { outputTypes: ['text'] } }).version).not.toBe(
      assemble({ contract: { outputTypes: ['json'] } }).version,
    );
  });

  it('does not change when only the input does — the version is of the prompt, not the run', () => {
    expect(assemble().version).toBe(
      assemble({ envelopes: [envelope([{ type: 'text', text: 'different input' }])] }).version,
    );
  });

  it('is computed from exactly the three things §2.8 names', () => {
    expect(promptVersion(SYSTEM_BASE_VERSION, 'Summarise the brief in one paragraph.', {
      outputTypes: ['text'],
    })).toBe(assemble().version);
  });
});

/* -------------------------------------------------------------------------- */
/* Redaction                                                                   */
/* -------------------------------------------------------------------------- */

describe('TC-SYS-008 / FR-PRM-005 a stored prompt carries no credential', () => {
  it('masks a key-shaped string that reached the prompt', () => {
    const leaked = `sk-ant-${'api03'}-AAAAAAAAAAAAAAAAAAAAAAAA`;
    const { redactedText } = assemble({
      envelopes: [envelope([{ type: 'text', text: `the key is ${leaked}` }])],
    });

    expect(redactedText).not.toContain(leaked);
    expect(redactedText).toContain('[REDACTED]');
  });

  it('leaves the text that is actually sent untouched', () => {
    const { text, redactedText } = assemble();

    expect(text).toBe(redactedText);
  });
});

/* -------------------------------------------------------------------------- */
/* A direct chat's conversation (round 4 §4 item 5)                            */
/* -------------------------------------------------------------------------- */

describe('FR-CHAT-004 D-079 the prompt manager carries a direct chat thread as ## Conversation', () => {
  const conversation = {
    transcript: 'User: Bonjour\nAssistant: Salut\nUser: What is next?',
    latestText: 'What is next?',
  };
  const headersOf = (text: string): string[] =>
    text.split('\n').filter((line) => line.startsWith('## '));

  it('a run prompt has no Conversation section — a handoff carries no history (BR-02)', () => {
    expect(assemble().text).not.toContain(CONVERSATION_SECTION);
    expect(headersOf(assemble().text)).toEqual([...PROMPT_SECTIONS]);
  });

  it('puts the thread between Context and Input, as the node’s own bounded context', () => {
    const { text } = assemble({ envelopes: [envelope([])], conversation });

    expect(headersOf(text)).toEqual([
      '## System',
      '## Instructions',
      '## Skills',
      '## Guardrails',
      '## Context',
      CONVERSATION_SECTION,
      '## Input',
      '## Output contract',
    ]);
    expect(text).toContain(`${CONVERSATION_SECTION}\n${conversation.transcript}\n\n## Input\n`);
    // The turns are the conversation itself, not untrusted input.
    expect(text).not.toContain(UNTRUSTED_LABEL);
  });

  it('{{input.text}} is the newest turn, and the version is still the configuration’s', () => {
    const instructions = 'Reply to: {{input.text}}';
    const { text, version } = assemble({ instructions, envelopes: [envelope([])], conversation });

    expect(text).toContain('Reply to: What is next?');
    expect(version).toBe(
      promptVersion(SYSTEM_BASE_VERSION, instructions, { outputTypes: ['text'] }),
    );
  });

  it('labels an untrusted input block with the label it is given', () => {
    const image: Part = {
      type: 'image',
      artifactId: ARTIFACT,
      mime: 'image/png',
      name: 'shot.png',
      size: 3,
    };
    const { text } = assemble({
      envelopes: [envelope([image])],
      conversation,
      inputLabel: 'Attachments to the latest message',
    });

    expect(text).toContain(
      `## Input\nAttachments to the latest message:\n${UNTRUSTED_LABEL}\n[image shot.png (3 bytes, image/png)]\n`,
    );
    expect(text).not.toContain('Input from upstream nodes');
  });
});
