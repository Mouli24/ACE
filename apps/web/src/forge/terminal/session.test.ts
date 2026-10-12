import { describe, expect, it } from 'vitest';

import { installMockServer } from '../../test/app';
import { busyLine } from './line-discipline';
import { enqueue } from './session';
import { errorLine, scrollbackOf, tabOf, useTerminalStore } from './terminal-store';

installMockServer();

const P = 'project-1';

/** A tab that has just started a run, as Enter leaves it: busy, nothing attached yet. */
function runningTab(): string {
  const store = useTerminalStore.getState();
  const tabId = store.newTab(P);
  const tab = tabOf(P, tabId);
  if (tab !== undefined) store.setLine(P, tabId, busyLine(tab.line));
  return tabId;
}

const shown = (tabId: string): string => {
  const tab = tabOf(P, tabId);
  return tab === undefined ? '' : scrollbackOf(tab);
};

describe('D301 a tab’s queue never fails silently', () => {
  it('a step that throws prints an error line in the tab and gives the prompt back', async () => {
    const tabId = runningTab();
    await enqueue(P, tabId, () => Promise.reject(new Error('boom')));
    expect(shown(tabId)).toBe(`~ $ ${errorLine('Terminal error: boom')}~ $ `);
    expect(tabOf(P, tabId)?.line.busy).toBe(false);
  });

  it('a step that throws while a process runs prints the error and keeps the tab attached', async () => {
    const tabId = runningTab();
    useTerminalStore.getState().attach(P, tabId, 'proc-1');
    await enqueue(P, tabId, () => Promise.reject(new Error('boom')));
    expect(shown(tabId)).toBe(`~ $ ${errorLine('Terminal error: boom')}`);
    expect(tabOf(P, tabId)?.processId).toBe('proc-1');
  });

  it('the steps after a failure still run', async () => {
    const tabId = runningTab();
    const ran: string[] = [];
    void enqueue(P, tabId, () => Promise.reject(new Error('boom')));
    await enqueue(P, tabId, async () => {
      ran.push('next');
    });
    expect(ran).toEqual(['next']);
  });
});
