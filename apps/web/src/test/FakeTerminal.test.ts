import { describe, expect, it } from 'vitest';

import { FakeTerminal, screenText } from './FakeTerminal';

describe('the FakeTerminal double shows what a person would see', () => {
  it('applies CR, LF, Backspace, cursor moves and erase-to-end, and drops colours', () => {
    expect(screenText('~ $ echo hx\b \bi')).toBe('~ $ echo hi');
    expect(screenText('ab\u001b[1Dc')).toBe('ac');
    expect(screenText('abc\u001b[2D\u001b[K')).toBe('a');
    expect(screenText('\u001b[31mred\u001b[0m\r\nnext')).toBe('red\nnext');
    expect(screenText('one\ntwo')).toBe('one\ntwo');
  });

  it('reports typing to onData, but not with stdin disabled', () => {
    const term = new FakeTerminal();
    const typed: string[] = [];
    term.onData((data) => typed.push(data));
    term.type('ls\r');
    term.options['disableStdin'] = true;
    term.type('no');
    expect(typed).toEqual(['ls\r']);
  });
});
