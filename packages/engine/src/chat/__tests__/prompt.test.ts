import type { ChatMessage, Part } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { estimateTokens } from '../../envelopes/index.js';
import {
  CONVERSATION_SECTION,
  SYSTEM_BASE_TEXT,
  SYSTEM_BASE_VERSION,
  UNTRUSTED_LABEL,
  promptVersion,
} from '../../prompts/index.js';
import { buildChatPrompt, renderConversation, type BuildChatPromptInput } from '../prompt.js';

const turn = (role: 'user' | 'agent', text: string): ChatMessage => ({
  id: `id-${text}`,
  threadId: 'thread',
  role,
  content: [{ type: 'text', text }],
  verdicts: [],
  at: '2026-09-30T10:00:00.000Z',
});

/** The body of one `## ` section of an assembled prompt, without its header. */
function section(text: string, header: string): string {
  const start = text.indexOf(`${header}\n`);
  if (start === -1) return '';
  const body = text.slice(start + header.length + 1);
  const next = body.search(/^## /m);
  return (next === -1 ? body : body.slice(0, next)).replace(/\n+$/, '');
}

const build = (overrides: Partial<BuildChatPromptInput> = {}): ReturnType<typeof buildChatPrompt> =>
  buildChatPrompt({
    conversationId: 'c1',
    nodeId: 'n1',
    instructions: 'Please answer in French.',
    inputTypes: ['text'],
    budgetTokens: 4000,
    history: [turn('user', 'Bonjour'), turn('agent', 'Salut')],
    userParts: [{ type: 'text', text: 'What is next?' }],
    now: '2026-09-30T10:00:00.000Z',
    ...overrides,
  });

describe('FR-CHAT-004 D-079 a direct chat prompt carries the thread as ## Conversation', () => {
  it('uses the same system base, instructions and version as a run of the same agent', () => {
    const prompt = build();

    expect(prompt.system).toBe(SYSTEM_BASE_TEXT);
    // The agent's instructions reach the prompt unchanged — the mock keys "answer in French" off it.
    expect(section(prompt.text, '## Instructions')).toBe('Please answer in French.');
    expect(prompt.version).toBe(
      promptVersion(SYSTEM_BASE_VERSION, 'Please answer in French.', { outputTypes: ['text'] }),
    );
  });

  it('puts the earlier turns and the new one under ## Conversation, each labelled with its role', () => {
    const prompt = build();

    expect(section(prompt.text, CONVERSATION_SECTION)).toBe(
      'User: Bonjour\nAssistant: Salut\nUser: What is next?',
    );
    // The user's own turn is neither untrusted upstream input nor anywhere but the conversation.
    expect(section(prompt.text, '## Input')).toBe('');
    expect(section(prompt.text, '## Context')).toBe('');
    expect(prompt.text).not.toContain(UNTRUSTED_LABEL);
    expect(prompt.text).not.toContain('Input from upstream nodes');
  });

  it('opens a thread with the new turn alone', () => {
    const prompt = build({ history: [] });
    expect(section(prompt.text, CONVERSATION_SECTION)).toBe('User: What is next?');
  });

  it('keeps an attachment’s content in an untrusted block — the file is not the user’s words (BR-13)', () => {
    const image: Part = {
      type: 'image',
      artifactId: 'a1',
      mime: 'image/png',
      name: 'shot.png',
      size: 1234,
    };
    const prompt = build({ userParts: [{ type: 'text', text: 'describe this' }, image] });

    // The conversation says a file was attached; the reference the model reads is fenced.
    expect(section(prompt.text, CONVERSATION_SECTION)).toBe(
      'User: Bonjour\nAssistant: Salut\nUser: describe this\n[image: shot.png]',
    );
    expect(section(prompt.text, '## Input')).toBe(
      `Attachments to the latest message:\n${UNTRUSTED_LABEL}\n[image shot.png (1234 bytes, image/png)]`,
    );
  });

  it('resolves {{input.text}} to the new turn, as a run resolves it to its input', () => {
    const prompt = build({ instructions: 'Answer this: {{input.text}}' });
    expect(section(prompt.text, '## Instructions')).toBe('Answer this: What is next?');
  });

  it('caps the conversation to contextPolicy.budgetTokens, dropping the oldest turns first', () => {
    const history: ChatMessage[] = Array.from({ length: 50 }, (_, i) =>
      turn(i % 2 === 0 ? 'user' : 'agent', `message number ${i} with some words`),
    );
    const budget = 40;
    const conversation = section(
      build({ history, budgetTokens: budget }).text,
      CONVERSATION_SECTION,
    );

    expect(estimateTokens(conversation)).toBeLessThanOrEqual(budget);
    // The new turn is never the one dropped, and the tail it continues is kept.
    expect(conversation.endsWith('User: What is next?')).toBe(true);
    expect(conversation).toContain('message number 49');
    expect(conversation).not.toContain('message number 0 ');
  });

  it('keeps a new turn larger than the whole budget, truncated to it', () => {
    const long = 'word '.repeat(500);
    const conversation = section(
      build({ userParts: [{ type: 'text', text: long }], budgetTokens: 5 }).text,
      CONVERSATION_SECTION,
    );

    expect(conversation.startsWith('User: word')).toBe(true);
    expect(estimateTokens(conversation)).toBeLessThanOrEqual(5);
  });
});

describe('renderConversation — the fitting rule behind ## Conversation', () => {
  it('caps to the budget, keeping the most recent turns', () => {
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

  it('renders an empty conversation to nothing', () => {
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
