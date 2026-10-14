import { describe, expect, it } from 'vitest';

import { OutputBuffer, capOutput } from './output.js';

describe('FR-TOOL-008 agent command output cap (agentic nodes)', () => {
  it('returns short output unchanged', () => {
    expect(capOutput('hello', 10)).toBe('hello');
    expect(capOutput('x'.repeat(10), 10)).toBe('x'.repeat(10));
  });

  it('keeps the head and the tail of long output and marks the cut', () => {
    const text = `HEAD${'m'.repeat(100_000)}TAIL`;
    const capped = capOutput(text);
    expect(capped.startsWith('HEAD')).toBe(true);
    expect(capped.endsWith('TAIL')).toBe(true);
    const cut = text.length - 30_000;
    expect(capped).toContain(`[… ${cut} chars cut …]`);
    expect(capped.replace(/\n?\[… \d+ chars cut …\]\n?/, '').length).toBe(30_000);
  });

  it('honours a smaller cap', () => {
    const capped = capOutput('abcdefghij', 4);
    expect(capped).toBe('ab\n[… 6 chars cut …]\nij');
  });
});

describe('OutputBuffer', () => {
  it('keeps everything under its limit', () => {
    const buffer = new OutputBuffer(100);
    buffer.push('ab');
    buffer.push('cd');
    expect(buffer.text(30_000)).toBe('abcd');
    expect(buffer.dropped).toBe(0);
  });

  it('retains a head and a rolling tail, counting what it dropped', () => {
    const buffer = new OutputBuffer(10);
    for (const chunk of ['01234', '56789', 'abcde', 'fghij']) buffer.push(chunk);
    expect(buffer.dropped).toBe(10);
    expect(buffer.length).toBe(20);
    const text = buffer.text(1_000);
    expect(text.startsWith('01234')).toBe(true);
    expect(text.endsWith('fghij')).toBe(true);
    expect(text).toContain('[… 10 chars cut …]');
  });

  it('take() empties it', () => {
    const buffer = new OutputBuffer(10);
    buffer.push('hello');
    expect(buffer.take(100)).toBe('hello');
    expect(buffer.take(100)).toBe('');
  });
});
