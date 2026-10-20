import { describe, expect, it } from 'vitest';

import type { StreamChunk, ToolResult } from '../adapter.js';
import { createMockAdapter } from '../adapters/mock.js';

/** Agentic nodes Phase 2: `mock-agent` plays a scripted chain of tool calls. */

const adapter = () => createMockAdapter({ sleep: async () => {} });

const SCRIPT = [
  '[[turn 1]]',
  '[[tool write_file {"path":"a.txt","content":"hi"}]]',
  '[[turn 2]]',
  '[[tool run_command {"command":"node --version"}]]',
  '[[turn 3]]',
  'Done.',
].join('\n');

const promptFor = (instructions: string): string =>
  `## System\nbase\n\n## Instructions\n${instructions}\n\n## Input\ngo\n`;

const results = (...ids: string[]): ToolResult[] =>
  ids.map((callId) => ({ callId, name: 'x', result: 'ok' }));

async function run(prompt: string, toolResults?: ToolResult[]): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  const signal = new AbortController().signal;
  for await (const chunk of adapter().generate(
    {
      modelId: 'mock-agent',
      prompt,
      outputTypes: ['text'],
      ...(toolResults === undefined ? {} : { toolResults }),
    },
    signal,
  )) {
    chunks.push(chunk);
  }
  return chunks;
}

const calls = (chunks: StreamChunk[]) =>
  chunks.filter((c): c is Extract<StreamChunk, { type: 'tool_call' }> => c.type === 'tool_call');

describe('mock-agent', () => {
  it('is listed with tools and no JSON', async () => {
    const model = (await adapter().listModels()).find((m) => m.modelId === 'mock-agent');
    expect(model?.supportsTools).toBe(true);
    expect(model?.supportsJson).toBe(false);
    expect(model?.contextWindow).toBe(200_000);
  });

  it('turn 1 emits the write_file call', async () => {
    const chunks = await run(promptFor(SCRIPT));
    expect(calls(chunks)).toEqual([
      {
        type: 'tool_call',
        callId: 'mock-1-0',
        name: 'write_file',
        args: { path: 'a.txt', content: 'hi' },
      },
    ]);
    expect(chunks.find((c) => c.type === 'usage')).toEqual({
      type: 'usage',
      tokensIn: 100,
      tokensOut: 20,
    });
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: 'tool_calls' });
  });

  it('turn 2 (one result back) emits run_command', async () => {
    const chunks = await run(promptFor(SCRIPT), results('mock-1-0'));
    expect(calls(chunks)).toEqual([
      {
        type: 'tool_call',
        callId: 'mock-2-0',
        name: 'run_command',
        args: { command: 'node --version' },
      },
    ]);
    expect(chunks.find((c) => c.type === 'usage')).toMatchObject({ tokensIn: 200 });
  });

  it('turn 3 answers in text and ends the loop', async () => {
    const chunks = await run(promptFor(SCRIPT), results('mock-1-0', 'mock-2-0'));
    expect(calls(chunks)).toEqual([]);
    expect(
      chunks
        .filter((c) => c.type === 'text')
        .map((c) => (c as { delta: string }).delta)
        .join(''),
    ).toBe('Done.');
    expect(chunks.find((c) => c.type === 'usage')).toMatchObject({ tokensIn: 300 });
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: 'stop' });
  });

  it('counts a turn once however many results it had', async () => {
    const two = `[[turn 1]]\n[[tool a {}]]\n[[tool b {"n":1}]]\n[[turn 2]]\nEnd.`;
    const first = await run(promptFor(two));
    expect(calls(first).map((c) => c.callId)).toEqual(['mock-1-0', 'mock-1-1']);
    const second = await run(promptFor(two), results('mock-1-0', 'mock-1-1'));
    expect(calls(second)).toEqual([]);
  });

  it('throws invalid_config naming the line on bad JSON', async () => {
    const bad = '[[turn 1]]\n[[tool write_file {oops}]]';
    await expect(run(promptFor(bad))).rejects.toMatchObject({
      nodeError: { kind: 'invalid_config' },
      message: expect.stringContaining('[[tool write_file {oops}]]'),
    });
  });

  it('throws invalid_config naming a [[tool line that is not the tool-line form', async () => {
    for (const line of ['[[tool write_file]]', '[[tool write_file {"path":"a.txt"}', '[[tool ]]']) {
      await expect(run(promptFor(`[[turn 1]]\n${line}`))).rejects.toMatchObject({
        nodeError: { kind: 'invalid_config', code: 'bad_agent_script' },
        message: expect.stringContaining(line),
      });
    }
  });

  it('D377: with turns, the turn is the number of turns so far plus one', async () => {
    const turn = (callId: string) => ({
      text: '',
      toolCalls: [{ callId, name: 'x', args: {} }],
      results: results(callId),
    });
    const chunks: StreamChunk[] = [];
    for await (const chunk of adapter().generate(
      {
        modelId: 'mock-agent',
        prompt: promptFor(SCRIPT),
        outputTypes: ['text'],
        // Turns supersede toolResults: two turns so far is turn 3, whatever toolResults says.
        turns: [turn('a'), turn('b')],
        toolResults: results('mock-1-0'),
      },
      new AbortController().signal,
    )) {
      chunks.push(chunk);
    }
    expect(calls(chunks)).toEqual([]);
    expect(chunks.find((c) => c.type === 'usage')).toMatchObject({ tokensIn: 300 });
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: 'stop' });

    const first = await (async () => {
      const out: StreamChunk[] = [];
      for await (const chunk of adapter().generate(
        { modelId: 'mock-agent', prompt: promptFor(SCRIPT), outputTypes: ['text'], turns: [] },
        new AbortController().signal,
      )) {
        out.push(chunk);
      }
      return out;
    })();
    expect(calls(first).map((c) => c.callId)).toEqual(['mock-1-0']);
  });
});
