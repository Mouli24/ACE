import type { ChatMessage, Part } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { estimateTokens } from '../../envelopes/index.js';
import { SYSTEM_BASE_TEXT, UNTRUSTED_LABEL } from '../../prompts/index.js';
import { buildChatPrompt, renderConversation } from '../prompt.js';

const turn = (role: 'user' | 'agent', text: string): ChatMessage => ({
  id: `id-${text}`,
  threadId: 'thread',
  role,
  content: [{ type: 'text', text }],
  verdicts: [],
  at: '2026-09-30T10:00:00.000Z',
});

describe('chat prompt assembly (FR-CHAT-004, FR-PRM-002)', () => {
  const userParts: Part[] = [{ type: 'text', text: 'What is next?' }];

  it('uses the same system base as a run and labels the conversation untrusted', () => {
    const prompt = buildChatPrompt({
      conversationId: 'c1',
      nodeId: 'n1',
      instructions: 'Please answer in French.',
      inputTypes: ['text'],
      budgetTokens: 4000,
      history: [turn('user', 'Bonjour'), turn('agent', 'Salut')],
      userParts,
      now: '2026-09-30T10:00:00.000Z',
    });

    expect(prompt.system).toBe(SYSTEM_BASE_TEXT);
    // The agent's instructions reach the prompt unchanged — the mock keys "answer in French" off it.
    expect(prompt.text).toContain('Please answer in French.');
    // The conversation is in the context, labelled untrusted (BR-13); the new turn is the input.
    expect(prompt.text).toContain('Conversation so far:');
    expect(prompt.text).toContain(UNTRUSTED_LABEL);
    expect(prompt.text).toContain('What is next?');
    expect(prompt.version).toHaveLength(12);
  });

  it('caps the conversation to the budget, keeping the most recent turns', () => {
    const history: ChatMessage[] = Array.from({ length: 50 }, (_, i) =>
      turn(i % 2 === 0 ? 'user' : 'agent', `message number ${i} with some words`),
    );
    const budget = 40;
    const rendered = renderConversation(history, budget);

    expect(estimateTokens(rendered)).toBeLessThanOrEqual(budget);
    // The tail (the thread the user is continuing) is kept, the opening is dropped.
    expect(rendered).toContain('message number 49');
    expect(rendered).not.toContain('message number 0 ');
  });

  it('renders an empty conversation to no context block', () => {
    expect(renderConversation([], 4000)).toBe('');
  });

  it('renders code, json and media turns as references, never bytes', () => {
    const history: ChatMessage[] = [
      { ...turn('user', 'x'), content: [{ type: 'code', language: 'ts', text: 'const a = 1;' }] },
      { ...turn('agent', 'y'), content: [{ type: 'json', value: { ok: true } }] },
      {
        ...turn('user', 'z'),
        content: [{ type: 'image', artifactId: 'a1', mime: 'image/png', name: 'p.png', size: 3 }],
      },
    ];
    const rendered = renderConversation(history, 4000);
    expect(rendered).toContain('const a = 1;');
    expect(rendered).toContain('"ok":true');
    expect(rendered).toContain('[image: p.png]');
  });

  it('keeps a single turn that is larger than the whole budget, truncated', () => {
    const long = 'word '.repeat(500);
    const rendered = renderConversation([turn('user', long)], 5);
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.length).toBeLessThan(long.length);
  });
});
