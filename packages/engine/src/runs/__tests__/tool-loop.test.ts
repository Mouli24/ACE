import { describe, expect, it } from 'vitest';

import {
  UNTRUSTED_TOOL_RESULT_LABEL,
  buildToolCall,
  mediaTypeForMime,
  redactArgs,
  summariseResult,
  toolResultBlock,
} from '../tool-loop.js';

const NODE_RUN_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0NRN5';
const CALL_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0CALL1';

describe('FR-TOOL-009 redactArgs masks credentials in a tool call arguments', () => {
  it('TC-TOOL-009 masks a value under a credential-shaped field name whatever it looks like', () => {
    const redacted = redactArgs({ url: 'https://api.example.com', apiKey: 'plainish-value' });
    expect(redacted).toEqual({ url: 'https://api.example.com', apiKey: '[REDACTED]' });
  });

  it('masks a credential-shaped string value even under an innocent field name', () => {
    const key = `sk-ant-${'api03'}-AAAABBBBCCCCDDDDEEEE0000`;
    const redacted = redactArgs({ note: `use ${key} here` }) as { note: string };
    expect(redacted.note).not.toContain(key);
    expect(redacted.note).toContain('[REDACTED]');
  });

  it('leaves ordinary arguments untouched, preserving shape', () => {
    expect(redactArgs({ text: 'hello', count: 3, nested: { ok: true } })).toEqual({
      text: 'hello',
      count: 3,
      nested: { ok: true },
    });
  });

  it('recurses through arrays and nested objects under a secret field name', () => {
    const redacted = redactArgs({ token: ['a', 'b'] });
    expect(redacted).toEqual({ token: ['[REDACTED]', '[REDACTED]'] });
  });
});

describe('summariseResult keeps a tool result short and value-safe (§2.2)', () => {
  it('stringifies an object and caps it at 500 characters', () => {
    const summary = summariseResult({ text: 'x'.repeat(2000) });
    expect(summary.length).toBeLessThanOrEqual(500);
  });

  it('returns a string result as itself', () => {
    expect(summariseResult('the answer')).toBe('the answer');
  });

  it('masks a credential-shaped run in the summary', () => {
    const key = `sk-ant-${'api03'}-AAAABBBBCCCCDDDDEEEE0000`;
    expect(summariseResult({ out: key })).not.toContain(key);
  });
});

describe('FR-TOOL-010 / FR-PRM-002 an untrusted tool result reaches the prompt labelled', () => {
  it('wraps the result in the untrusted tool-result label', () => {
    const block = toolResultBlock('echo', { text: 'hi' });
    expect(block).toContain(UNTRUSTED_TOOL_RESULT_LABEL);
    expect(block).toContain('echo');
    expect(block).toContain('hi');
  });
});

describe('FR-MM-003 mediaTypeForMime maps a MIME to a media data type', () => {
  it('classifies each family', () => {
    expect(mediaTypeForMime('image/png')).toBe('image');
    expect(mediaTypeForMime('audio/mpeg')).toBe('audio');
    expect(mediaTypeForMime('video/mp4')).toBe('video');
    expect(mediaTypeForMime('application/zip')).toBe('file');
    expect(mediaTypeForMime('text/plain; charset=utf-8')).toBe('file');
  });
});

describe('FR-TOOL-009 buildToolCall shapes a logged call', () => {
  it('redacts args and carries every field', () => {
    const call = buildToolCall({
      id: CALL_ID,
      nodeRunId: NODE_RUN_ID,
      toolName: 'http_request',
      args: { url: 'https://x', token: 'secret-token' },
      resultSummary: 'status 200',
      durationMs: 12,
      status: 'ok',
      verdicts: [],
      at: '2026-09-30T00:00:00.000Z',
    });
    expect(call).toMatchObject({
      toolName: 'http_request',
      resultSummary: 'status 200',
      durationMs: 12,
      status: 'ok',
    });
    expect(call.args).toEqual({ url: 'https://x', token: '[REDACTED]' });
  });
});
