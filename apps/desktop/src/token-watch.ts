import { readFileSync, watch } from 'node:fs';
import { basename, dirname } from 'node:path';

/** Read the session token, or `undefined` while the file is missing or empty. */
export function readTokenFile(file: string): string | undefined {
  try {
    const token = readFileSync(file, 'utf8').trim();
    return token === '' ? undefined : token;
  } catch {
    return undefined;
  }
}

/** A directory watcher: calls `onEvent` with the changed entry's name (`null` when unknown). */
export type WatchDir = (
  dir: string,
  onEvent: (filename: string | null) => void,
  onError: () => void,
) => { close(): void };

const watchDir: WatchDir = (dir, onEvent, onError) => {
  const watcher = watch(dir, (_event, filename) =>
    onEvent(filename === null ? null : String(filename)),
  );
  watcher.on('error', onError);
  return watcher;
};

export interface TokenWatcherOptions {
  /** `<dataDir>/session-token`. */
  file: string;
  /** The token the window already uses; only a different one is reported. */
  current?: string;
  /** Called with each new token, once the writes that produced it have settled. */
  onChange: (token: string) => void;
  /** `fs.watch` fires several times for one write on Windows; events closer than this are one. */
  debounceMs?: number;
  /**
   * A slow re-check besides the watcher: it starts the watcher once the data dir exists (it may not
   * on a first run) and covers an event a watcher dropped.
   */
  pollMs?: number;
  readToken?: (file: string) => string | undefined;
  watchDir?: WatchDir;
}

export interface TokenWatcher {
  close(): void;
}

/**
 * Watch the engine's session-token file and report each new token (D295).
 *
 * The engine writes a fresh token on every start, so under `tsx watch` an edit to `apps/server`
 * restarts it with a token the open window does not have. This is how the dev window finds out.
 */
export function watchSessionToken(options: TokenWatcherOptions): TokenWatcher {
  const read = options.readToken ?? readTokenFile;
  const startWatching = options.watchDir ?? watchDir;
  const debounceMs = options.debounceMs ?? 300;
  const dir = dirname(options.file);
  const name = basename(options.file);

  let current = options.current;
  let closed = false;
  let pending: ReturnType<typeof setTimeout> | undefined;
  let watcher: { close(): void } | undefined;

  const check = (): void => {
    pending = undefined;
    if (closed) return;
    const token = read(options.file);
    if (token === undefined || token === current) return;
    current = token;
    options.onChange(token);
  };

  const schedule = (): void => {
    if (closed) return;
    if (pending !== undefined) clearTimeout(pending);
    pending = setTimeout(check, debounceMs);
  };

  const ensureWatcher = (): void => {
    if (watcher !== undefined || closed) return;
    try {
      watcher = startWatching(
        dir,
        (filename) => {
          if (filename === null || filename === name) schedule();
        },
        () => {
          // The folder went away (or the handle broke): drop the watcher; the poll starts another.
          watcher?.close();
          watcher = undefined;
        },
      );
    } catch {
      watcher = undefined; // no data dir yet — the poll tries again
    }
  };

  ensureWatcher();
  const poll = setInterval(() => {
    ensureWatcher();
    schedule();
  }, options.pollMs ?? 5_000);

  return {
    close() {
      closed = true;
      clearInterval(poll);
      if (pending !== undefined) clearTimeout(pending);
      watcher?.close();
      watcher = undefined;
    },
  };
}
