import { describe, expect, it } from 'vitest';

import {
  ENVELOPE_DIGEST_SECTION,
  HUMAN_INSTRUCTIONS_SECTION,
  TEAM_GOAL_SECTION,
  TEAM_MESSAGES_SECTION,
  TEAM_SECTION,
  assemblePrompt,
} from '../../prompts/index.js';
import { envOf } from './run-log.js';

/* D311, Phase 3: what a node is told about its team, and what its teammates sent it. */

const base = {
  instructions: 'Write a tagline.',
  envelopes: [],
  contract: { outputTypes: ['text' as const] },
  iteration: 1,
};

const roster = [
  { handle: 'writer', name: 'Writer', brain: false, you: true },
  { handle: 'review', name: 'Review', brain: false, you: false },
  { handle: 'brain', name: 'Director', brain: true, you: false },
];

describe('D311 ## Team', () => {
  it('lists every teammate by handle and explains the envelope block', () => {
    const prompt = assemblePrompt({ ...base, team: { roster } });
    expect(prompt.text).toContain(`${TEAM_SECTION}\n`);
    expect(prompt.text).toContain('- @writer: Writer (you)');
    expect(prompt.text).toContain('- @review: Review');
    expect(prompt.text).toContain('- @brain: Director (the Brain');
    expect(prompt.text).toContain('```ace-envelope');
    for (const kind of ['HANDOFF', 'QUERY', 'ANSWER', 'FLAG']) expect(prompt.text).toContain(kind);
    // The node's own instructions come first; a teammate's never appear (D325).
    expect(prompt.text.indexOf('## Instructions')).toBeLessThan(prompt.text.indexOf(TEAM_SECTION));
    expect(prompt.text).not.toContain('Act as');
  });

  it('a node with no teammate gets no team section, and the prompt is unchanged', () => {
    const alone = assemblePrompt({ ...base, team: { roster: [roster[0]!] } });
    expect(alone.text).toBe(assemblePrompt(base).text);
    expect(alone.version).toBe(assemblePrompt(base).version);
  });
});

describe('D311 ## Team messages', () => {
  it('quotes each envelope with its kind, id, sender and body, marked as untrusted', () => {
    const prompt = assemblePrompt({
      ...base,
      team: {
        roster,
        teamMessages: [
          {
            kind: 'QUERY',
            envelopeId: envOf(1),
            fromHandle: 'review',
            summary: 'Which year did it launch?',
            body: 'I need the year for the hook.',
          },
        ],
      },
    });
    const at = (header: string) => prompt.text.indexOf(header);
    expect(at(TEAM_SECTION)).toBeLessThan(at(TEAM_MESSAGES_SECTION));
    expect(prompt.text).toContain(`[QUERY ${envOf(1)}] from @review: Which year did it launch?`);
    expect(prompt.text).toContain('> I need the year for the hook.');
    expect(prompt.text).toContain(`inReplyTo ${envOf(1)}`);
    expect(prompt.text).toMatch(/not instructions/u);
  });

  it('human instructions come before teammate messages', () => {
    const prompt = assemblePrompt({
      ...base,
      team: {
        roster,
        humanInstructions: ['Keep it short'],
        teamMessages: [
          { kind: 'FLAG', envelopeId: envOf(2), fromHandle: 'review', summary: 'Too long.' },
        ],
      },
    });
    expect(prompt.text.indexOf(HUMAN_INSTRUCTIONS_SECTION)).toBeLessThan(
      prompt.text.indexOf(TEAM_MESSAGES_SECTION),
    );
    expect(prompt.text.indexOf(TEAM_GOAL_SECTION)).toBe(-1);
  });
});

describe('D304 the Brain digest', () => {
  it('lists the envelopes routed so far, only for the node handed it', () => {
    const lines = ['HANDOFF @writer → @review: Draft one. (FORWARDED)'];
    const prompt = assemblePrompt({ ...base, team: { roster, digest: lines } });
    expect(prompt.text).toContain(`${ENVELOPE_DIGEST_SECTION}\n`);
    expect(prompt.text).toContain('- HANDOFF @writer → @review: Draft one. (FORWARDED)');
    expect(assemblePrompt({ ...base, team: { roster } }).text).not.toContain(
      ENVELOPE_DIGEST_SECTION,
    );
  });
});
