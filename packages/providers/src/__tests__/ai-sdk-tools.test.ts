import type { ToolDefinition } from '@ace/contracts';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import { describe, expect, it } from 'vitest';

import type { StreamChunk } from '../adapter.js';
import { createAiSdkAdapter } from '../adapters/ai-sdk.js';

const usage = (input: number, output: number) => ({
  inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: output, text: output, reasoning: undefined },
});

const readFile: ToolDefinition = {
  name: 'read_file',
  description: 'Reads a text file in the project folder.',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
    additionalProperties: false,
  },
  outputSchema: { type: 'object' },
  permissions: { network: false, fsPaths: ['<project>'], destructive: false },
  timeoutMs: 10_000,
  source: 'builtin',
};

const adapterOver = (model: MockLanguageModelV4) =>
  createAiSdkAdapter({
    type: 'anthropic',
    model: () => model,
    check: async () => ({ status: 'CONNECTED' }),
    listModels: async () => [],
  });

async function drain(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

const saysDone = () =>
  new MockLanguageModelV4({
    doStream: async () => ({
      stream: convertArrayToReadableStream([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: 'Done.' },
        { type: 'text-end', id: 't' },
        { type: 'finish', finishReason: { unified: 'stop', raw: 'end_turn' }, usage: usage(20, 2) },
      ]),
    }),
  });

describe('X1 §4.4 API and local models call ACE’s tools (FR-TOOL-003)', () => {
  it('offers the enabled tools and surfaces the model’s call for ACE to run', async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: convertArrayToReadableStream([
          { type: 'stream-start', warnings: [] },
          { type: 'tool-call', toolCallId: 'call_1', toolName: 'read_file', input: '{"path":"src/math.js"}' },
          { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_use' }, usage: usage(12, 3) },
        ]),
      }),
    });

    const chunks = await drain(
      adapterOver(model).generate(
        { modelId: 'm', prompt: 'Fix it.', outputTypes: ['text'], tools: [readFile] },
        new AbortController().signal,
      ),
    );

    expect(chunks).toContainEqual({
      type: 'tool_call',
      callId: 'call_1',
      name: 'read_file',
      args: { path: 'src/math.js' },
    });
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: 'tool_calls' });
    const offered = model.doStreamCalls[0]?.tools ?? [];
    expect(offered.map((tool) => ('name' in tool ? tool.name : undefined))).toEqual(['read_file']);
  });

  it('continues after a tool result, replaying the call before its result', async () => {
    const model = saysDone();
    const chunks = await drain(
      adapterOver(model).generate(
        {
          modelId: 'm',
          prompt: 'Fix it.',
          outputTypes: ['text'],
          tools: [readFile],
          toolResults: [
            { callId: 'call_1', name: 'read_file', args: { path: 'src/math.js' }, result: { content: 'export const add' } },
          ],
        },
        new AbortController().signal,
      ),
    );

    expect(chunks.flatMap((chunk) => (chunk.type === 'text' ? [chunk.delta] : [])).join('')).toBe('Done.');
    const prompt = model.doStreamCalls[0]?.prompt ?? [];
    expect(prompt.map((message) => message.role)).toEqual(['user', 'assistant', 'tool']);
    expect(JSON.stringify(prompt[1])).toContain('call_1');
    expect(JSON.stringify(prompt[1])).toContain('src/math.js');
    expect(JSON.stringify(prompt[2])).toContain('export const add');
  });

  it('a call with no tools is a single prompt with no tools, as before', async () => {
    const model = saysDone();
    await drain(adapterOver(model).generate({ modelId: 'm', prompt: 'Hi.', outputTypes: ['text'] }, new AbortController().signal));
    expect(model.doStreamCalls[0]?.tools ?? []).toEqual([]);
    expect((model.doStreamCalls[0]?.prompt ?? []).map((message) => message.role)).toEqual(['user']);
  });
});
