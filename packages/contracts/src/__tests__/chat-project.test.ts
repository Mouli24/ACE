import { describe, expect, it } from 'vitest';

import {
  ACTIVITY_KINDS,
  ACTIVITY_SUMMARY_MAX,
  ActivityItemSchema,
  ChatMessageSchema,
  ChatRequestSchema,
  resolveChatTarget,
} from '../chat.js';
import { rosterFor, type RosterEntry } from '../domain.js';
import { PartSchema } from '../envelope.js';
import { AgentConfigSchema, type Node } from '../graph.js';
import { CHAT_MESSAGE_ID, NODE_A, NOW, THREAD_ID } from './fixtures.js';

/*
 * D302: chat in the project. A turn may name another node of the workflow with `@handle`, the
 * reply records who spoke and what it did, and a code part can point at a file and its lines.
 */

const WF = '01JBXQ8Z9KQ4R7N2VWXYZ0WKFW';
const id = (n: number): string => `01JBXQ8Z9KQ4R7N2VWXYZ0N${String(n).padStart(3, '0')}`;

function agent(n: number, name: string, extra: { handle?: string; brain?: boolean } = {}): Node {
  return {
    id: id(n),
    workflowId: WF,
    kind: 'agent',
    name,
    position: { x: 0, y: 0 },
    inputs: [],
    outputs: [],
    ...(extra.handle === undefined ? {} : { handle: extra.handle }),
    config: AgentConfigSchema.parse({
      instructions: `Act as ${name}.`,
      inputTypes: ['text'],
      outputTypes: ['text'],
      ...(extra.brain === undefined ? {} : { brain: extra.brain }),
    }),
  };
}

const roster: RosterEntry[] = rosterFor([
  agent(1, 'Coder'),
  agent(2, 'Reviewer'),
  agent(3, 'Risk Analyst'),
]);
const MAIN = id(1);

describe('D302 resolveChatTarget', () => {
  it('sends a plain message to the main node', () => {
    expect(resolveChatTarget('please fix the build', roster, MAIN)).toEqual({ targetNodeId: MAIN });
    expect(resolveChatTarget('', roster, MAIN)).toEqual({ targetNodeId: MAIN });
  });

  it('sends a message with one @handle to that node, wherever the handle sits', () => {
    expect(resolveChatTarget('@reviewer look at this', roster, MAIN)).toEqual({
      targetNodeId: id(2),
    });
    expect(resolveChatTarget('what do you think, @Reviewer?', roster, MAIN)).toEqual({
      targetNodeId: id(2),
    });
    expect(resolveChatTarget('@risk-analyst check it', roster, MAIN)).toEqual({
      targetNodeId: id(3),
    });
  });

  it('honours only handles: a plain name is just a word', () => {
    expect(resolveChatTarget('ask the Reviewer later', roster, MAIN)).toEqual({
      targetNodeId: MAIN,
    });
  });

  it('counts the same handle twice as one node', () => {
    expect(resolveChatTarget('@reviewer and again @reviewer', roster, MAIN)).toEqual({
      targetNodeId: id(2),
    });
  });

  it('may name the main node itself', () => {
    expect(resolveChatTarget('@coder go on', roster, MAIN)).toEqual({ targetNodeId: MAIN });
  });

  it('refuses two different handles', () => {
    const result = resolveChatTarget('@coder and @reviewer, both of you', roster, MAIN);
    expect(result.targetNodeId).toBeUndefined();
    expect(result.error).toMatch(/one node at a time/);
  });

  it('refuses @all', () => {
    const result = resolveChatTarget('@all status?', roster, MAIN);
    expect(result.targetNodeId).toBeUndefined();
    expect(result.error).toMatch(/@all/);
  });

  it('refuses an unknown handle with Domain’s words and its nearest handles', () => {
    const result = resolveChatTarget('@reviwer hi', roster, MAIN);
    expect(result.targetNodeId).toBeUndefined();
    expect(result.error).toContain('no node is @reviwer');
    expect(result.error).toContain('@reviewer');
  });

  it('refuses @brain on a board without one', () => {
    const result = resolveChatTarget('@brain plan it', roster, MAIN);
    expect(result.error).toMatch(/Brain/);
  });

  it('leaves an email address alone', () => {
    expect(resolveChatTarget('mail me@example.com', roster, MAIN)).toEqual({ targetNodeId: MAIN });
  });
});

describe('D302 fix B-M3: ordinary @ text in a coding chat neither blocks Send nor retargets', () => {
  // the conversation's main node is the Reviewer here, so a message for the Coder is visible
  const REVIEWER = id(2);
  const CODER = id(1);

  it.each([
    ['@types/node is missing', REVIEWER],
    ['npm i @scope/pkg', REVIEWER],
    ['use `@x` here', REVIEWER],
    ["Cannot find module '@ace/contracts'", REVIEWER],
    ['add @Injectable() to the class', REVIEWER],
    ['@coder fix it', CODER],
    ['please @coder fix it', CODER],
    ['ask about @nobody later', REVIEWER],
    ['say "@coder" in the docs', REVIEWER],
    ['the `@coder fix` example', REVIEWER],
    ['```ts\n@Component({})\nclass A {}\n@nobody\n```\nwhy does this fail?', REVIEWER],
    ['```\n@coder\n```\n@coder look at the block above', CODER],
    ['`@scope/pkg` and @coder', CODER],
  ])('%j goes to the expected node, with no error', (text, expected) => {
    expect(resolveChatTarget(text, roster, REVIEWER)).toEqual({ targetNodeId: expected });
  });

  it('a typo of a real handle as the first word is still refused, with the nearest handle', () => {
    const result = resolveChatTarget('@codr fix it', roster, REVIEWER);
    expect(result.targetNodeId).toBeUndefined();
    expect(result.error).toContain('no node is @codr');
    expect(result.error).toContain('@coder');
    expect(resolveChatTarget('  @codr fix it', roster, REVIEWER).error).toContain('@coder');
  });

  it('keeps @all refused wherever it is, and two real handles refused', () => {
    expect(resolveChatTarget('ping @all please', roster, REVIEWER).error).toMatch(/@all/);
    expect(resolveChatTarget('please @coder and @reviewer', roster, REVIEWER).error).toMatch(
      /one node at a time/,
    );
  });
});

describe('D302 ChatRequest.targetNodeId', () => {
  it('is optional and must be an id', () => {
    const content = [{ type: 'text', text: 'hi' }];
    expect(ChatRequestSchema.parse({ content, targetNodeId: NODE_A })).toEqual({
      content,
      targetNodeId: NODE_A,
    });
    expect(ChatRequestSchema.safeParse({ content, targetNodeId: 'nope' }).success).toBe(false);
  });
});

describe('D302 ChatMessage speaker, activity and checkpoint', () => {
  const reply = {
    id: CHAT_MESSAGE_ID,
    threadId: THREAD_ID,
    role: 'agent',
    content: [{ type: 'text', text: 'Done.' }],
    verdicts: [],
    at: NOW,
  };

  it('carries who spoke, what it did and its checkpoint', () => {
    const full = {
      ...reply,
      speakerNodeId: NODE_A,
      activity: [
        { kind: 'edit', tool: 'edit_file', path: 'src/a.ts', summary: 'Edited src/a.ts' },
        { kind: 'command', tool: 'Bash', summary: 'Ran pnpm test' },
      ],
      checkpointId: CHAT_MESSAGE_ID,
    };
    expect(ChatMessageSchema.parse(full)).toEqual(full);
    expect(ChatMessageSchema.parse(reply)).toEqual(reply);
  });

  it('declares the six activity kinds', () => {
    expect([...ACTIVITY_KINDS]).toEqual(['read', 'write', 'edit', 'command', 'search', 'other']);
  });

  it('keeps an activity summary to 200 characters and refuses file contents by shape', () => {
    expect(ACTIVITY_SUMMARY_MAX).toBe(200);
    const item = { kind: 'read', tool: 'read_file', path: 'a.ts', summary: 'x'.repeat(200) };
    expect(ActivityItemSchema.safeParse(item).success).toBe(true);
    expect(ActivityItemSchema.safeParse({ ...item, summary: 'x'.repeat(201) }).success).toBe(false);
    expect(ActivityItemSchema.safeParse({ ...item, content: 'file body' }).success).toBe(false);
    expect(ActivityItemSchema.safeParse({ ...item, kind: 'delete' }).success).toBe(false);
  });
});

describe('D302 a code part can point at a file and its lines', () => {
  it('takes path, startLine and endLine, all optional', () => {
    const part = {
      type: 'code',
      language: 'typescript',
      text: 'const a = 1;',
      path: 'src/a.ts',
      startLine: 3,
      endLine: 7,
    };
    expect(PartSchema.parse(part)).toEqual(part);
    expect(PartSchema.parse({ type: 'code', language: 'ts', text: '' })).toBeDefined();
  });

  it('refuses a line below 1 and an empty path', () => {
    const base = { type: 'code', language: 'ts', text: 'x' };
    expect(PartSchema.safeParse({ ...base, startLine: 0 }).success).toBe(false);
    expect(PartSchema.safeParse({ ...base, endLine: 1.5 }).success).toBe(false);
    expect(PartSchema.safeParse({ ...base, path: '' }).success).toBe(false);
  });
});
