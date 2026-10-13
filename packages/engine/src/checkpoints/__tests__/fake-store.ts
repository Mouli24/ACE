import {
  CheckpointConflictError,
  CheckpointUnavailableError,
  type CheckpointFileDiffEntry,
  type CheckpointStore,
} from '../../ports/index.js';

/**
 * The checkpoint store over an in-memory folder: `disk` is the project folder (path → text, or
 * bytes for a binary file), each snapshot a frozen copy under a fake commit id. The real store is
 * covered against git in `@ace/tools`; this one lets the service's rules be tested on their own.
 */
export interface FakeCheckpointStore extends CheckpointStore {
  disk: Map<string, string | Uint8Array>;
  /** The next snapshot throws this, once. */
  failNext: Error | undefined;
  /** Pinned refs by `<checkpointId>/<side>`. */
  refs: Map<string, string>;
  snapshots: number;
}

const encode = (value: string | Uint8Array): Uint8Array =>
  typeof value === 'string' ? new TextEncoder().encode(value) : value;

const lines = (text: string): string[] => (text === '' ? [] : text.replace(/\n$/, '').split('\n'));

const isBinary = (value: string | Uint8Array | undefined): boolean =>
  value !== undefined && typeof value !== 'string';

const same = (a: string | Uint8Array | undefined, b: string | Uint8Array | undefined): boolean => {
  if (a === undefined || b === undefined) return a === b;
  const x = encode(a);
  const y = encode(b);
  return x.length === y.length && x.every((byte, index) => byte === y[index]);
};

export function fakeCheckpointStore(): FakeCheckpointStore {
  const commits = new Map<string, Map<string, string | Uint8Array>>();
  let next = 0;
  const commitOf = (id: string): Map<string, string | Uint8Array> => {
    const tree = commits.get(id);
    if (tree === undefined) throw new Error(`no commit ${id}`);
    return tree;
  };

  const store: FakeCheckpointStore = {
    disk: new Map(),
    failNext: undefined,
    refs: new Map(),
    snapshots: 0,

    async snapshot(_projectId, _root, target) {
      if (store.failNext !== undefined) {
        const error = store.failNext;
        store.failNext = undefined;
        throw error;
      }
      store.snapshots += 1;
      next += 1;
      const id = next.toString(16).padStart(40, '0');
      commits.set(id, new Map(store.disk));
      store.refs.set(`${target.checkpointId}/${target.side}`, id);
      return { commit: id, skipped: [] };
    },

    async diff(_projectId, before, after) {
      const a = commitOf(before);
      const b = commitOf(after);
      const files: CheckpointFileDiffEntry[] = [];
      for (const path of [...new Set([...a.keys(), ...b.keys()])].sort()) {
        const was = a.get(path);
        const now = b.get(path);
        if (same(was, now)) continue;
        const binary = isBinary(was) || isBinary(now);
        const old = typeof was === 'string' ? lines(was) : [];
        const fresh = typeof now === 'string' ? lines(now) : [];
        files.push({
          path,
          change: was === undefined ? 'added' : now === undefined ? 'deleted' : 'modified',
          additions: binary ? 0 : fresh.filter((line) => !old.includes(line)).length,
          deletions: binary ? 0 : old.filter((line) => !fresh.includes(line)).length,
          binary,
        });
      }
      return files;
    },

    async fileAt(_projectId, commit, path) {
      const value = commitOf(commit).get(path);
      return value === undefined ? undefined : encode(value);
    },

    async revertFile(_projectId, _root, before, after, path) {
      if (!same(store.disk.get(path), commitOf(after).get(path))) {
        throw new CheckpointConflictError(path);
      }
      const was = commitOf(before).get(path);
      if (was === undefined) store.disk.delete(path);
      else store.disk.set(path, was);
    },

    async drop(_projectId, checkpointId) {
      store.refs.delete(`${checkpointId}/before`);
      store.refs.delete(`${checkpointId}/after`);
    },
  };
  return store;
}

export const gitMissing = (): CheckpointUnavailableError =>
  new CheckpointUnavailableError('git_missing', 'git is not installed or not on PATH.');
