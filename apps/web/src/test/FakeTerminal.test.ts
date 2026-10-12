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

  it('clear() keeps the current line as the new first line, like xterm', () => {
    const term = new FakeTerminal();
    term.write('a\r\nb');
    term.clear();
    expect(term.plain()).toBe('b');
    term.write('c');
    expect(term.plain()).toBe('bc');
  });

  it('reports keys to onKey and resizes to onResize', () => {
    const term = new FakeTerminal();
    const keys: Array<{ key: string; code: string }> = [];
    const sizes: Array<{ cols: number; rows: number }> = [];
    term.onKey((event) => keys.push({ key: event.key, code: event.domEvent.code }));
    term.onResize((size) => sizes.push(size));
    term.type('x');
    term.press({ code: 'KeyA', key: 'a' });
    term.resize(100, 30);
    expect(keys).toEqual([
      { key: 'x', code: '' },
      { key: 'a', code: 'KeyA' },
    ]);
    expect(sizes).toEqual([{ cols: 100, rows: 30 }]);
    expect([term.cols, term.rows]).toEqual([100, 30]);
  });
});

describe('D301 ESC c (RIS) in the write stream', () => {
  it('clears the whole screen, in order with what was written before it', () => {
    expect(screenText('a\u001bcb')).toBe('b');
    expect(screenText('one\r\ntwo\u001bcthree')).toBe('three');
  });
});
