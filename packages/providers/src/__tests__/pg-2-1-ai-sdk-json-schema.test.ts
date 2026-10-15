/**
 * PG-2.1 Provider support for output contracts (docs/team-prompts/product-gaps-fix-prompt.md).
 *
 * Phase 0 red test. The executor hands the node's schema to the adapter as `jsonSchema`
 * (`engine/src/runs/executor.ts` ~982), but the AI SDK adapter drops it
 * (`adapters/ai-sdk.ts` ~355): the model is never asked for structured output. After the fix a
 * provider that supports structured output receives the schema as a JSON response format;
 * prompt-only enforcement stays the fallback.
 */
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import { describe, expect, it } from 'vitest';

import type { StreamChunk } from '../adapter.js';
import { createAiSdkAdapter } from '../adapters/ai-sdk.js';

const SCHEMA = {
  type: 'object',
  properties: { verdict: { type: 'string' }, score: { type: 'number' } },
  required: ['verdict', 'score'],
  additionalProperties: false,
};

const usage = (input: number, output: number) => ({
  inputTokens: {
    total: input,
    noCache: input,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: output, text: output, reasoning: undefined },
});

const answersJson = () =>
  new MockLanguageModelV4({
    doStream: async () => ({
      stream: convertArrayToReadableStream([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't' },
        {
          type: 'text-delta',
          id: 't',
          delta: '{"verdict":"approved","score":8}',
        },
        { type: 'text-end', id: 't' },
        {
          type: 'finish',
          finishReason: { unified: 'stop', raw: 'end_turn' },
          usage: usage(10, 8),
        },
      ]),
    }),
  });

async function drain(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

const adapterOver = (model: MockLanguageModelV4) =>
  createAiSdkAdapter({
    type: 'openai',
    model: () => model,
    check: async () => ({ status: 'CONNECTED' }),
    listModels: async () => [],
  });

describe('PG-2.1 the AI SDK adapter passes jsonSchema to the provider', () => {
  it.fails('a request with a jsonSchema asks the model for JSON in that schema', async () => {
    const model = answersJson();

    await drain(
      adapterOver(model).generate(
        {
          modelId: 'm',
          prompt: 'Review it.',
          outputTypes: ['json'],
          jsonSchema: SCHEMA,
        },
        new AbortController().signal,
      ),
    );

    expect(model.doStreamCalls[0]?.responseFormat).toMatchObject({
      type: 'json',
      schema: SCHEMA,
    });
  });

  it('control: a request without a schema asks for no JSON format (passes today)', async () => {
    const model = answersJson();

    await drain(
      adapterOver(model).generate(
        { modelId: 'm', prompt: 'Write it.', outputTypes: ['text'] },
        new AbortController().signal,
      ),
    );

    expect(model.doStreamCalls[0]?.responseFormat?.type ?? 'text').toBe('text');
  });
});
