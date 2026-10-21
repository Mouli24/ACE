import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fileKeys } from './keys';
import { applyFilesChanged } from './project-socket';

const PID = '01J9ZZZZZZZZZZZZZZZZZZZZZZ';
let client: QueryClient;

beforeEach(() => {
  vi.useFakeTimers();
  client = new QueryClient();
  for (const key of [
    fileKeys.folder(PID, ''),
    fileKeys.folder(PID, 'src'),
    fileKeys.folder(PID, 'src/deep'),
    fileKeys.content(PID, 'src/a.ts'),
    fileKeys.content(PID, 'src/deep/b.ts'),
    fileKeys.content(PID, 'README.md'),
    fileKeys.list(PID),
    fileKeys.status(PID),
  ]) {
    client.setQueryData(key, {});
  }
});
afterEach(() => vi.useRealTimers());

const stale = (key: readonly unknown[]) => client.getQueryState(key)?.isInvalidated ?? false;

describe('D299 a files.changed burst refreshes what shows it', () => {
  it('a changed file: its folder and its content, not quick open’s list', () => {
    applyFilesChanged(client, {
      projectId: PID,
      changes: [{ path: 'src/a.ts', kind: 'changed' }],
      resync: false,
    });
    expect(stale(fileKeys.folder(PID, 'src'))).toBe(true);
    expect(stale(fileKeys.content(PID, 'src/a.ts'))).toBe(true);
    expect(stale(fileKeys.content(PID, 'README.md'))).toBe(false);
    expect(stale(fileKeys.list(PID))).toBe(false);
  });

  it('a deleted folder: its parent, everything inside it, and the list', () => {
    applyFilesChanged(client, {
      projectId: PID,
      changes: [{ path: 'src/deep', kind: 'deleted' }],
      resync: false,
    });
    expect(stale(fileKeys.folder(PID, 'src'))).toBe(true);
    expect(stale(fileKeys.folder(PID, 'src/deep'))).toBe(true);
    expect(stale(fileKeys.content(PID, 'src/deep/b.ts'))).toBe(true);
    expect(stale(fileKeys.content(PID, 'src/a.ts'))).toBe(false);
    expect(stale(fileKeys.list(PID))).toBe(true);
  });

  it('[audit F-6] a changed .gitignore refreshes the list and every folder: what they show may change', () => {
    applyFilesChanged(client, {
      projectId: PID,
      changes: [{ path: 'src/.gitignore', kind: 'changed' }],
      resync: false,
    });
    expect(stale(fileKeys.list(PID))).toBe(true);
    expect(stale(fileKeys.folder(PID, ''))).toBe(true);
    expect(stale(fileKeys.folder(PID, 'src/deep'))).toBe(true);
    expect(stale(fileKeys.content(PID, 'README.md'))).toBe(false);
  });

  it('a resync refreshes everything of the project', () => {
    applyFilesChanged(client, { projectId: PID, changes: [], resync: true });
    expect(stale(fileKeys.content(PID, 'README.md'))).toBe(true);
    expect(stale(fileKeys.folder(PID, ''))).toBe(true);
  });

  it('refetches the repository status at most once a second', () => {
    const spy = vi.spyOn(client, 'invalidateQueries');
    for (let i = 0; i < 5; i += 1) {
      applyFilesChanged(client, {
        projectId: PID,
        changes: [{ path: 'README.md', kind: 'changed' }],
        resync: false,
      });
    }
    const statusCalls = () =>
      spy.mock.calls.filter(
        ([filters]) => JSON.stringify(filters?.queryKey) === JSON.stringify(fileKeys.status(PID)),
      );
    expect(statusCalls()).toHaveLength(0);
    vi.advanceTimersByTime(1000);
    expect(statusCalls()).toHaveLength(1);
  });
});
