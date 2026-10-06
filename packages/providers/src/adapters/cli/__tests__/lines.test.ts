import { describe, expect, it } from 'vitest';

import { createLineSplitter, parseJsonLine } from '../lines.js';

describe('X1 CLI stdout lines (review focus 5)', () => {
  it('joins a line split across reads and splits CRLF', () => {
    const splitter = createLineSplitter();
    expect(splitter.push('{"a":1}\r\n{"b"')).toEqual(['{"a":1}']);
    expect(splitter.push(':2}\n\n')).toEqual(['{"b":2}']);
    expect(splitter.push('{"c":3}')).toEqual([]);
    expect(splitter.end()).toEqual(['{"c":3}']);
  });

  it('skips banners, arrays and broken JSON instead of failing', () => {
    expect(parseJsonLine('Loading Claude Code…')).toBeUndefined();
    expect(parseJsonLine('[1,2]')).toBeUndefined();
    expect(parseJsonLine('{"type":')).toBeUndefined();
    expect(parseJsonLine('  {"type":"result"}  ')).toEqual({ type: 'result' });
  });
});
