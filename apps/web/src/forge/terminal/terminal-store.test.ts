import { beforeEach, describe, expect, it } from 'vitest';

import { busyLine, promptFor } from './line-discipline';
import {
  LOST_NOTE,
  TERMINAL_SCROLLBACK_MAX,
  UNOWNED_MAX,
  exitLine,
  scrollbackOf,
  useTerminalStore,
} from './terminal-store';

const P = 'p1';
const store = () => useTerminalStore.getState();
const tab = (id = 't1') => {
  const found = store().projects[P]?.tabs.find((each) => each.id === id);
  if (found === undefined) throw new Error(`no tab ${id}`);
  return found;
};
const shown = (id = 't1') => scrollbackOf(tab(id));

/** A tab running process X, as a start would leave it. */
function running(processId = 'X'): void {
  store().newTab(P);
  store().setLine(P, 't1', busyLine(tab().line));
  store().attach(P, 't1', processId);
}

beforeEach(() => store().reset());

describe('D301 terminal tabs live outside the view, per project', () => {
  it('prompts with the working folder, or ~ at the root', () => {
    expect(promptFor('')).toBe('~ $ ');
    expect(promptFor('src/app')).toBe('src/app $ ');
  });

  it('a new tab shows its prompt, becomes active and is named in order', () => {
    expect(store().newTab(P)).toBe('t1');
    expect(store().newTab(P, { label: 'dev', cwd: 'web' })).toBe('t2');
    expect(store().projects[P]).toMatchObject({ active: 't2', next: 3 });
    expect(tab('t1').label).toBe('Terminal 1');
    expect(shown('t1')).toBe('~ $ ');
    expect(tab('t2')).toMatchObject({ label: 'dev', cwd: 'web' });
    expect(shown('t2')).toBe('web $ ');
  });

  it('closing a tab activates its right neighbour, else its left', () => {
    store().newTab(P);
    store().newTab(P);
    store().newTab(P);
    store().activate(P, 't2');
    store().closeTab(P, 't2');
    expect(store().projects[P]?.active).toBe('t3');
    store().closeTab(P, 't3');
    expect(store().projects[P]?.active).toBe('t1');
    store().closeTab(P, 't1');
    expect(store().projects[P]).toMatchObject({ tabs: [], active: undefined });
  });

  it('renames a tab, ignoring a blank name', () => {
    store().newTab(P);
    store().rename(P, 't1', '  api  ');
    expect(tab().label).toBe('api');
    store().rename(P, 't1', '   ');
    expect(tab().label).toBe('api');
  });

  it('output of the attached process goes to its tab; its end says how it ended and prompts again', () => {
    running();
    store().output(P, 'X', 'boom\n');
    store().exited(P, 'X', { exitCode: 2, signal: null, status: 'exited' });
    expect(shown()).toBe('~ $ boom\n\u001b[2m[exit 2]\u001b[0m\r\n~ $ ');
    expect(tab()).toMatchObject({ processId: undefined, live: '' });
    expect(tab().line.busy).toBe(false);
  });

  it('starts the prompt on a new line when the output did not end one', () => {
    running();
    store().output(P, 'X', 'no newline');
    store().exited(P, 'X', { exitCode: 0, signal: null, status: 'exited' });
    expect(shown()).toBe('~ $ no newline\r\n~ $ ');
  });

  it('output that beats the start’s answer waits for the tab, and so does an early end', () => {
    store().newTab(P);
    store().output(P, 'X', 'hi\n');
    store().exited(P, 'X', { exitCode: 0, signal: null, status: 'exited' });
    expect(store().unowned['X']).toEqual({
      output: 'hi\n',
      exit: { exitCode: 0, signal: null, status: 'exited' },
    });

    store().setLine(P, 't1', busyLine(tab().line));
    store().attach(P, 't1', 'X');
    expect(shown()).toBe('~ $ hi\n~ $ ');
    expect(store().unowned['X']).toBeUndefined();
    expect(tab().processId).toBeUndefined();
    expect(tab().line.busy).toBe(false);
  });

  it('a tab keeps only the last 1,048,576 characters', () => {
    expect(TERMINAL_SCROLLBACK_MAX).toBe(1_048_576);
    running();
    store().output(P, 'X', 'x'.repeat(TERMINAL_SCROLLBACK_MAX));
    store().output(P, 'X', 'END');
    expect(shown()).toHaveLength(TERMINAL_SCROLLBACK_MAX);
    expect(shown().endsWith('xEND')).toBe(true);
    expect(tab().total).toBe('~ $ '.length + TERMINAL_SCROLLBACK_MAX + 'END'.length);
  });

  it('never keeps half a character at the front', () => {
    running();
    store().output(P, 'X', `😀${'x'.repeat(TERMINAL_SCROLLBACK_MAX - 2)}`);
    expect(shown().startsWith('😀')).toBe(true);
    // one more character cuts through 😀: its second half must not stay behind
    store().output(P, 'X', '!');
    expect(shown().charCodeAt(0)).toBe('x'.charCodeAt(0));
    expect(shown()).toHaveLength(TERMINAL_SCROLLBACK_MAX - 1);
  });

  it('a re-attach replaces only the process’s part, and tells the view to redraw', () => {
    store().newTab(P);
    store().write(P, 't1', 'serve\r\n');
    store().setLine(P, 't1', busyLine(tab().line));
    store().attach(P, 't1', 'X');
    store().output(P, 'X', 'a\n');
    const { epoch } = tab();
    store().replaceLive(P, 'X', 'a\nb\n');
    expect(shown()).toBe('~ $ serve\r\na\nb\n');
    expect(tab().epoch).toBe(epoch + 1);
  });

  it('clearScreen empties the tab and redraws; idle puts the prompt back', () => {
    store().newTab(P, { cwd: 'src' });
    store().write(P, 't1', 'old\r\n');
    const { epoch } = tab();
    store().clearScreen(P, 't1');
    expect(shown()).toBe('');
    expect(tab().epoch).toBe(epoch + 1);
    store().idle(P, 't1');
    expect(shown()).toBe('src $ ');
  });

  it('a lost process ends the run with a note and the prompt', () => {
    running();
    store().lost(P, 'X');
    expect(shown()).toBe(`~ $ \r\n${LOST_NOTE}~ $ `);
    expect(tab().processId).toBeUndefined();
  });

  it('holds at most 20 processes no tab owns, dropping the oldest', () => {
    for (let i = 0; i < UNOWNED_MAX + 5; i += 1) store().output(P, `p${i}`, 'x');
    const kept = Object.keys(store().unowned);
    expect(kept).toHaveLength(UNOWNED_MAX);
    expect(kept[0]).toBe('p5');
  });

  it('says how a process ended: nothing for 0, the code, the signal, or that it never started', () => {
    expect(exitLine({ exitCode: 0, signal: null, status: 'exited' })).toBe('');
    expect(exitLine({ exitCode: 1, signal: null, status: 'exited' })).toBe(
      '\u001b[2m[exit 1]\u001b[0m\r\n',
    );
    expect(exitLine({ exitCode: null, signal: 'SIGKILL', status: 'exited' })).toBe(
      '\u001b[2m[stopped (SIGKILL)]\u001b[0m\r\n',
    );
    expect(exitLine({ exitCode: null, signal: null, status: 'failed' })).toBe(
      '\u001b[2m[could not start]\u001b[0m\r\n',
    );
  });
});
