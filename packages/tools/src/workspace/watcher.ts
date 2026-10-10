import { watch, type FSWatcher } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import { FILES_CHANGED_MAX, type FileChange } from '@ace/contracts';
import type { FileChangeBatch } from '@ace/engine';

import { SAVE_TEMP_SUFFIX } from './fs-files.js';
import { createIgnoreRules } from './ignore-rules.js';

export interface WatchOptions {
  /** How long a burst collects before it is sent (design §6.1: 100 ms). */
  debounceMs?: number;
  /** More than this many paths in one burst is sent as `resync` instead. */
  maxChanges?: number;
}

/**
 * Watches a project folder recursively with Node's `fs.watch` (native recursion on Windows and
 * macOS; Node walks the tree on Linux) and reports bursts of project-relative paths. `.git`,
 * ignored folders and Forge's own temp save files are never reported. Contents are never read:
 * created, changed or deleted is decided by one `stat` when the burst is sent.
 */
export function watchProject(
  root: string,
  onChange: (batch: FileChangeBatch) => void,
  onError: (error: Error) => void,
  options: WatchOptions = {},
): () => void {
  const debounceMs = options.debounceMs ?? 100;
  const maxChanges = options.maxChanges ?? FILES_CHANGED_MAX;
  const rules = createIgnoreRules(root);
  const pending = new Map<string, 'rename' | 'change'>();
  let lostTrack = false;
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  let watcher: FSWatcher | undefined;

  const stop = (): void => {
    closed = true;
    if (timer !== undefined) clearTimeout(timer);
    watcher?.close();
  };

  /**
   * `ignore` throws on some names (an all-dots path such as `...` on POSIX). Such a path counts as
   * not ignored: a throw in the `fs.watch` listener would be an uncaught exception, and in a burst
   * an unhandled rejection — either takes the engine down (review minor 5).
   */
  const isIgnored = (rel: string, isFolder: boolean): boolean => {
    try {
      return rules.isIgnored(rel, isFolder);
    } catch {
      return false;
    }
  };

  async function flush(): Promise<void> {
    timer = undefined;
    const entries = [...pending.entries()];
    pending.clear();
    const resync = lostTrack || entries.length > maxChanges;
    lostTrack = false;
    if (closed || (entries.length === 0 && !resync)) return;
    if (resync) {
      onChange({ changes: [], resync: true });
      return;
    }
    const settled = await Promise.all(
      entries.map(async ([path, eventType]): Promise<FileChange | undefined> => {
        const info = await stat(join(root, path)).catch(() => undefined);
        // An ignored folder is never reported (design §6.1), and neither is a path that is gone
        // and may have been one: the cheap test in the callback only drops what is *under* it.
        if ((info === undefined || info.isDirectory()) && isIgnored(path, true)) return undefined;
        if (info === undefined) return { path, kind: 'deleted' };
        if (eventType === 'rename') return { path, kind: 'created' };
        // A folder's own "changed" only means something inside it changed; the children report
        // themselves, so `src` is not announced on every save inside it.
        return info.isDirectory() ? undefined : { path, kind: 'changed' };
      }),
    );
    const changes = settled.filter((change): change is FileChange => change !== undefined);
    if (changes.length === 0) return;
    if (!closed) onChange({ changes, resync: false });
  }

  const schedule = (): void => {
    if (timer === undefined) {
      timer = setTimeout(() => {
        // A burst that cannot be sent stops this watcher and says so, as an `error` event does;
        // the owner restarts it (review minor 5).
        flush().catch((error: unknown) => {
          stop();
          onError(error instanceof Error ? error : new Error(String(error)));
        });
      }, debounceMs);
    }
  };

  try {
    watcher = watch(root, { recursive: true, persistent: false }, (eventType, filename) => {
      if (closed) return;
      if (filename === null) {
        // the OS dropped the name: ask the client to refetch rather than guess
        lostTrack = true;
        schedule();
        return;
      }
      const rel = filename.split('\\').join('/');
      if (
        rel === '' ||
        rules.isHidden(rel) ||
        rel.endsWith(SAVE_TEMP_SUFFIX) ||
        isIgnored(rel, false)
      )
        return;
      if (rel === '.gitignore' || rel.endsWith('/.gitignore')) rules.clear();
      pending.set(rel, pending.get(rel) === 'rename' ? 'rename' : eventType);
      schedule();
    });
  } catch (error) {
    closed = true;
    queueMicrotask(() => onError(error instanceof Error ? error : new Error(String(error))));
    return () => undefined;
  }

  watcher.on('error', (error) => {
    stop();
    onError(error);
  });
  return stop;
}
