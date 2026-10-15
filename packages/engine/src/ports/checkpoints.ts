import type { Checkpoint, CheckpointFile, CheckpointUncapturedReason, Id } from '@ace/contracts';

/*
 * Checkpoints (D300, design §5). Two seams live here:
 *
 * - `CheckpointRecorder`, what a writer of project files — the chat service's writing turns (D302)
 *   and the run service — wraps its work in. Binding for Forge Phase 3's tracks A and B.
 * - `CheckpointStore`, the private git store the checkpoint service snapshots, diffs and reverts
 *   with. `createGitCheckpointStore` in `@ace/tools` implements it; `apps/server` wires it.
 */

/** What wrote the changes a checkpoint records. */
export type CheckpointMeta = {
  kind: 'chat' | 'run';
  threadId?: string;
  messageId?: string;
  runId?: string;
  nodeId?: string;
};

/** One recording in progress: `finish()` snapshots again and answers what changed. */
export interface CheckpointRecording {
  readonly id: string;
  /**
   * PG-2.4 (D361): set when the "before" snapshot could not be taken — the checkpoint is `failed`
   * from the start and nothing the writer does can be reverted. A writing run or turn stops here
   * unless the person chose "Run without undo".
   */
  readonly failed?: string;
  /**
   * `undefined` when nothing changed (the checkpoint is dropped); otherwise the checkpoint, which
   * is `pending`, or `failed` when the folder could not be snapshotted. Never throws, and a second
   * call answers what the first did.
   */
  finish(): Promise<Checkpoint | undefined>;
}

/** Begins a checkpoint before a writing turn or run (D300 §5.2). */
export interface CheckpointRecorder {
  begin(projectId: string, meta: CheckpointMeta): Promise<CheckpointRecording>;
  /**
   * D302 R-1: the files the person reverted in this chat thread's checkpoints since the thread's
   * last turn, project-relative, in the order they were reverted — answered once, then forgotten,
   * so the thread's next turn can tell the model. Absent on a recorder that keeps no such notes.
   */
  takeRevertedPaths?(threadId: string): string[];
  /**
   * D302 R-1: a turn that took them and then failed gives them back, ahead of any reverted since,
   * so the thread's next turn still hears them.
   */
  restoreRevertedPaths?(threadId: string, paths: readonly string[]): void;
}

/** One side of a checkpoint, pinned in the store under `refs/ace/<checkpointId>/<side>`. */
export interface SnapshotTarget {
  checkpointId: Id;
  side: 'before' | 'after';
}

/** A snapshot: the store's commit, and the files left out because they are over 5 MB. */
export interface SnapshotRef {
  commit: string;
  skipped: string[];
}

/**
 * A changed file as the store's diff reports it; the checkpoint adds its `state`. `uncaptured` is
 * set when either snapshot left the path out (its manifest says why): such a file is never
 * reverted, because there is no proof of what it was.
 */
export type CheckpointFileDiffEntry = Omit<CheckpointFile, 'state' | 'reason'> & {
  uncaptured?: CheckpointUncapturedReason;
};

/**
 * The private store: `<dataDir>/checkpoints/<projectId>.git`, outside the project's own `.git`,
 * which it never reads or writes (design §5.1). `root` is the project's absolute folder; paths are
 * project-relative with forward slashes.
 */
export interface CheckpointStore {
  /**
   * Every file of `root` that is not ignored (`.gitignore`, `.git`/`.ace` at any depth, ACE's
   * default excludes) and not over 5 MB, as one commit pinned under `target`, with a manifest of
   * every existing path it left out and why. The `after` side applies the ignore rules recorded
   * by the `before` side, so a `.gitignore` the agent changed never makes a file look added or
   * deleted. Throws {@link CheckpointUnavailableError} when git is missing, the folder cannot be
   * read, or it holds more files than a snapshot covers.
   */
  snapshot(projectId: Id, root: string, target: SnapshotTarget): Promise<SnapshotRef>;
  /** What changed from `before` to `after`, file by file, without rename detection. */
  diff(projectId: Id, before: string, after: string): Promise<CheckpointFileDiffEntry[]>;
  /**
   * The file's bytes in `commit`; `undefined` only when git proves it is not there. An unknown
   * commit or a store failure throws {@link CheckpointUnavailableError}.
   */
  fileAt(projectId: Id, commit: string, path: string): Promise<Uint8Array | undefined>;
  /**
   * Puts `path` back as it was at `before` — or deletes it, when the agent created it — but only
   * while the disk still holds what `after` recorded: otherwise {@link CheckpointConflictError}.
   * "Created" needs proof: absent from the `before` tree and not named by its manifest. A path
   * either snapshot left out is refused with a {@link CheckpointConflictError} saying why.
   */
  revertFile(
    projectId: Id,
    root: string,
    before: string,
    after: string,
    path: string,
  ): Promise<void>;
  /** Unpins a checkpoint's commits (it was dropped); git may collect them later. */
  drop(projectId: Id, checkpointId: Id): Promise<void>;
}

/* Shared through the global symbol registry, as `WorkspaceFsError` is: the tools package may
 * resolve to a different build of this module, and its errors must still be recognised. */
const UNAVAILABLE: unique symbol = Symbol.for('@ace/engine/CheckpointUnavailableError');
const CONFLICT: unique symbol = Symbol.for('@ace/engine/CheckpointConflictError');

/** Why the store cannot work: git is not installed, or the folder or the store failed. */
export type CheckpointUnavailableReason = 'git_missing' | 'failed';

export class CheckpointUnavailableError extends Error {
  override readonly name = 'CheckpointUnavailableError';
  readonly [UNAVAILABLE] = true;

  constructor(
    readonly reason: CheckpointUnavailableReason,
    message: string,
  ) {
    super(message);
  }
}

/** The file on disk is no longer what the agent left: reverting it would lose a later change. */
export class CheckpointConflictError extends Error {
  override readonly name = 'CheckpointConflictError';
  readonly [CONFLICT] = true;

  constructor(
    readonly path: string,
    /** Why it is refused, when it is not a later change: a path the snapshot left out. */
    message: string = `${path} changed after the agent's edit; review it before reverting`,
  ) {
    super(message);
  }
}

/** How a reason reads inside "ACE could not capture <path> (<words>)". */
export const UNCAPTURED_REASON_WORDS: Readonly<Record<CheckpointUncapturedReason, string>> = {
  ignored: 'ignored',
  too_large: 'over 5 MB',
  unreadable: 'unreadable',
  vanished: 'it vanished while being captured',
};

/** Why a path a snapshot left out is never reverted (D300 fix C1). */
export const uncapturedMessage = (path: string, reason: CheckpointUncapturedReason): string =>
  `ACE could not capture ${path} (${UNCAPTURED_REASON_WORDS[reason]}), so it can't be reverted`;

const branded = (error: unknown, brand: symbol): boolean =>
  error instanceof Error && (error as Error & Record<symbol, unknown>)[brand] === true;

export const isCheckpointUnavailableError = (error: unknown): error is CheckpointUnavailableError =>
  branded(error, UNAVAILABLE);

export const isCheckpointConflictError = (error: unknown): error is CheckpointConflictError =>
  branded(error, CONFLICT);
