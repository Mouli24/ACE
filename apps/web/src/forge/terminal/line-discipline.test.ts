import { describe, expect, it } from 'vitest';

import { HISTORY_MAX, feed, initialLineState, type LineState } from './line-discipline';

const state = (overrides: Partial<LineState> = {}): LineState => {
  const base = initialLineState(overrides.history ?? []);
  return { ...base, ...overrides, recall: overrides.recall ?? (overrides.history ?? []).length };
};

describe('D301 the line discipline: keys to echo and actions', () => {
  it.each([
    {
      name: 'printable text at the end is echoed as typed',
      from: state(),
      input: 'ls',
      line: 'ls',
      cursor: 2,
      echo: 'ls',
    },
    {
      name: 'text inserted mid-line redraws the rest and steps back',
      from: state({ line: 'lx', cursor: 1 }),
      input: 's',
      line: 'lsx',
      cursor: 2,
      echo: 'sx\u001b[1D',
    },
    {
      name: 'Backspace at the end rubs out one character',
      from: state({ line: 'ls', cursor: 2 }),
      input: '\u007f',
      line: 'l',
      cursor: 1,
      echo: '\b \u001b[1D',
    },
    {
      name: 'Backspace mid-line pulls the rest left',
      from: state({ line: 'lsx', cursor: 2 }),
      input: '\b',
      line: 'lx',
      cursor: 1,
      echo: '\bx \u001b[2D',
    },
    {
      name: 'Backspace at the start does nothing',
      from: state({ line: 'ls', cursor: 0 }),
      input: '\u007f',
      line: 'ls',
      cursor: 0,
      echo: '',
    },
    {
      name: 'Delete removes the character under the cursor',
      from: state({ line: 'abc', cursor: 1 }),
      input: '\u001b[3~',
      line: 'ac',
      cursor: 1,
      echo: 'c \u001b[2D',
    },
    {
      name: '← moves left, and stops at the start',
      from: state({ line: 'ls', cursor: 1 }),
      input: '\u001b[D\u001b[D',
      line: 'ls',
      cursor: 0,
      echo: '\u001b[1D',
    },
    {
      name: '→ moves right in application mode too, and stops at the end',
      from: state({ line: 'ls', cursor: 1 }),
      input: '\u001bOC\u001b[C',
      line: 'ls',
      cursor: 2,
      echo: '\u001b[1C',
    },
    {
      name: 'Home and End jump to the ends',
      from: state({ line: 'abc', cursor: 3 }),
      input: '\u001b[H',
      line: 'abc',
      cursor: 0,
      echo: '\u001b[3D',
    },
    {
      name: 'other escapes and control characters are dropped',
      from: state({ line: 'ls', cursor: 2 }),
      input: '\u001b[15~\u001bOP\t\u0001',
      line: 'ls',
      cursor: 2,
      echo: '',
    },
  ])('$name', ({ from, input, line, cursor, echo }) => {
    const step = feed(from, input);
    expect(step.state.line).toBe(line);
    expect(step.state.cursor).toBe(cursor);
    expect(step.echo).toBe(echo);
    expect(step.actions).toEqual([]);
  });

  it('↑ recalls the newest command, ↑ again an older one, ↓ walks back to the draft', () => {
    let current = state({ history: ['a', 'bb'], line: 'x', cursor: 1 });
    const up = feed(current, '\u001b[A');
    expect(up.state).toMatchObject({ line: 'bb', cursor: 2, recall: 1, draft: 'x' });
    expect(up.echo).toBe('\u001b[1Dbb\u001b[K');
    current = feed(up.state, '\u001b[A').state;
    expect(current).toMatchObject({ line: 'a', recall: 0 });
    expect(feed(current, '\u001b[A').state).toMatchObject({ line: 'a', recall: 0 });
    current = feed(current, '\u001b[B').state;
    expect(current).toMatchObject({ line: 'bb', recall: 1 });
    const down = feed(current, '\u001b[B');
    expect(down.state).toMatchObject({ line: 'x', cursor: 1, recall: 2 });
    expect(down.echo).toBe('\u001b[2Dx\u001b[K');
    expect(feed(down.state, '\u001bOB').state).toMatchObject({ line: 'x', recall: 2 });
  });

  it('Enter with a command runs it, remembers it and goes busy', () => {
    const step = feed(state({ history: ['ls'], line: 'echo hi', cursor: 7 }), '\r');
    expect(step.actions).toEqual([{ kind: 'run', line: 'echo hi' }]);
    expect(step.echo).toBe('\r\n');
    expect(step.state).toMatchObject({
      line: '',
      cursor: 0,
      busy: true,
      history: ['ls', 'echo hi'],
      recall: 2,
    });
  });

  it('Enter on an empty line only asks for a fresh prompt', () => {
    const step = feed(state({ line: '   ', cursor: 3 }), '\r');
    expect(step.actions).toEqual([{ kind: 'prompt' }]);
    expect(step.state).toMatchObject({ busy: false, history: [] });
  });

  it('Enter while a process runs sends the line and a newline to its stdin, unremembered', () => {
    const step = feed(state({ busy: true, line: 'Ada', cursor: 3 }), '\r');
    expect(step.actions).toEqual([{ kind: 'input', data: 'Ada\n' }]);
    expect(step.state).toMatchObject({ line: '', busy: true, history: [] });
  });

  it('Ctrl+C with nothing running clears the line and prompts again', () => {
    const step = feed(state({ line: 'oops', cursor: 4 }), '\u0003');
    expect(step.echo).toBe('^C\r\n');
    expect(step.actions).toEqual([{ kind: 'prompt' }]);
    expect(step.state).toMatchObject({ line: '', busy: false });
  });

  it('Ctrl+C while a process runs stops it, and stays busy until it has ended', () => {
    const step = feed(state({ busy: true, line: 'x', cursor: 1 }), '\u0003');
    expect(step.echo).toBe('^C\r\n');
    expect(step.actions).toEqual([{ kind: 'stop' }]);
    expect(step.state).toMatchObject({ line: '', busy: true });
  });

  it('a pasted block runs its first line, and its other lines go to what that started', () => {
    const step = feed(state(), 'echo a\r\necho b\r');
    expect(step.echo).toBe('echo a\r\necho b\r\n');
    expect(step.actions).toEqual([
      { kind: 'run', line: 'echo a' },
      { kind: 'input', data: 'echo b\n' },
    ]);
    expect(step.state.history).toEqual(['echo a']);
  });

  it('a pasted line ending in a bare \\n counts as Enter too', () => {
    expect(feed(state(), 'pwd\n').actions).toEqual([{ kind: 'run', line: 'pwd' }]);
  });

  it('remembers at most 100 commands and never the same one twice in a row', () => {
    let current = state();
    for (let i = 0; i < HISTORY_MAX + 5; i += 1) {
      current = { ...feed(current, `cmd ${i}\r`).state, busy: false };
    }
    current = { ...feed(current, `cmd ${HISTORY_MAX + 4}\r`).state, busy: false };
    expect(current.history).toHaveLength(HISTORY_MAX);
    expect(current.history[0]).toBe('cmd 5');
    expect(current.history.at(-1)).toBe(`cmd ${HISTORY_MAX + 4}`);
  });
});
