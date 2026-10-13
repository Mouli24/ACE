import {
  CHECKPOINT_DIFF_MAX_BYTES,
  type Checkpoint,
  type CheckpointAction,
  type CheckpointConflictDetails,
  type CheckpointFile,
  type CheckpointFileDiff,
  type CheckpointFileState,
  type CheckpointStatus,
  type Id,
} from '@ace/contracts';

import type { EventBus } from '../events/index.js';
import { HttpError, invalidPath, notFound } from '../gateway/errors.js';
import { newId } from '../ids.js';
import type { Logger } from '../logging/index.js';
import {
  isCheckpointConflictError,
  isCheckpointUnavailableError,
  isWorkspaceFsError,
  uncapturedMessage,
  type CheckpointFileDiffEntry,
  type CheckpointMeta,
  type CheckpointRecorder,
  type CheckpointRecording,
  type CheckpointRepository,
  type CheckpointStore,
  type Repository,
  type Scope,
  type StoredCheckpoint,
} from '../ports/index.js';
import { checkpointConflict, checkpointsUnavailable } from './errors.js';

/**
 * Checkpoints (D300, design §5): every writing chat turn and every run in a project with a folder
 * is wrapped in one. `begin` snapshots the folder into the private store, `finish` snapshots it
 * again and records what changed — or drops the checkpoint when nothing did. A person reviews
 * each file's diff and keeps or reverts it; a revert never overwrites a change made after the
 * agent's. Rows and frames carry paths and counts only (design §7).
 */
export interface CheckpointService extends CheckpointRecorder {
  /** Open ones (recording, pending) first, then the rest; newest first in each. */
  list(projectId: Id): Promise<Checkpoint[]>;
  get(projectId: Id, id: Id): Promise<Checkpoint>;
  /** One file before and after, for Monaco's diff editor: text up to 2 MB, else `binary`. */
  fileDiff(projectId: Id, id: Id, path: string): Promise<CheckpointFileDiff>;
  /**
   * Keep or revert every pending file, or the named ones. A revert that would lose a later change
   * leaves that file pending and answers 409 `checkpoint_conflict` once the rest are done.
   */
  act(projectId: Id, id: Id, action: CheckpointAction): Promise<Checkpoint>;
  /**
   * Engine start: a checkpoint the last process left recording is marked failed, and no after
   * snapshot is taken — whatever changed since may be the person's (D300 fix I3).
   */
  recover(): Promise<void>;
  /**
   * The person wrote these paths through Forge (a save, a create, a move, a remove). Every
   * checkpoint of the project still recording marks them — and anything under a folder among
   * them — `person`: listed, never reverted (D300 fix I3).
   */
  notePersonWrite(projectId: Id, paths: readonly string[]): void;
}

export interface CheckpointServiceDeps {
  store: CheckpointStore;
  repository: Repository;
  scope: Scope;
  bus: EventBus;
  logger: Logger;
  now?: () => string;
}

const STOPPED_WHILE_RECORDING =
  "the engine stopped while recording; these changes can't be told apart from yours";
/** How much of a file is searched for a NUL byte to call it binary — git's own heuristic. */
const SNIFF_BYTES = 8000;
const OPEN: ReadonlySet<CheckpointStatus> = new Set(['recording', 'pending']);
/** The states Keep and Revert decide; `person` and `not_revertible` are only listed. */
const DECIDABLE: ReadonlySet<CheckpointFileState> = new Set(['pending', 'kept', 'reverted']);

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Every decidable file decided closes the checkpoint: all kept, all reverted, or partly each. A
 * checkpoint with nothing it may revert is closed as kept: its changes stand.
 */
function statusOf(files: readonly CheckpointFile[]): CheckpointStatus {
  const decidable = files.filter((file) => DECIDABLE.has(file.state));
  if (decidable.some((file) => file.state === 'pending')) return 'pending';
  if (decidable.every((file) => file.state === 'kept')) return 'kept';
  if (decidable.every((file) => file.state === 'reverted')) return 'reverted';
  return 'partial';
}

/** `path` is one of the person's writes, or inside a folder they wrote (moved, removed). */
const touchedBy = (touched: ReadonlySet<string> | undefined, path: string): boolean => {
  if (touched === undefined) return false;
  for (const written of touched) {
    if (written === path || written === '' || path.startsWith(`${written}/`)) return true;
  }
  return false;
};

/** A diff entry as a checkpoint file: never revertible when uncaptured or the person's. */
function fileOf(entry: CheckpointFileDiffEntry, touched: ReadonlySet<string> | undefined) {
  const { uncaptured, ...file } = entry;
  if (uncaptured !== undefined) {
    return { ...file, state: 'not_revertible' as const, reason: uncaptured };
  }
  return {
    ...file,
    state: touchedBy(touched, file.path) ? ('person' as const) : ('pending' as const),
  };
}

/** Why a named file is not reverted, for the 409's details. */
function notRevertedMessage(file: CheckpointFile): string {
  return file.state === 'person'
    ? `You edited ${file.path} during the session, so it is not reverted here.`
    : uncapturedMessage(file.path, file.reason ?? 'unreadable');
}

/** UTF-8 text, `undefined` for a missing side, `null` for one Monaco cannot show as text. */
function textOf(bytes: Uint8Array | undefined): string | undefined | null {
  if (bytes === undefined) return undefined;
  if (bytes.length > CHECKPOINT_DIFF_MAX_BYTES) return null;
  if (bytes.subarray(0, SNIFF_BYTES).includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

const refused = (message: string): HttpError =>
  new HttpError('invalid_config', 'validation_failed', message, undefined, false);

export function createCheckpointService(deps: CheckpointServiceDeps): CheckpointService {
  const { store, scope, bus, logger } = deps;
  const now = deps.now ?? (() => new Date().toISOString());
  const rows: CheckpointRepository | undefined = deps.repository.checkpoints;
  if (rows === undefined) throw new Error('The checkpoint service needs a checkpoint repository.');
  const checkpoints: CheckpointRepository = rows;

  /** One action at a time per checkpoint: a finish, a keep and a revert never interleave. */
  const queues = new Map<Id, Promise<unknown>>();
  function serial<T>(id: Id, work: () => Promise<T>): Promise<T> {
    const run = (queues.get(id) ?? Promise.resolve()).then(work, work);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    queues.set(id, tail);
    void tail.then(() => {
      if (queues.get(id) === tail) queues.delete(id);
    });
    return run;
  }

  async function folderOf(projectId: Id): Promise<string> {
    const project = await deps.repository.projects.get(scope, projectId);
    if (project === null) throw notFound(`Project ${projectId}`);
    if (project.folderPath === '') throw invalidPath('(none)', 'this project has no folder.');
    return project.folderPath;
  }

  function announce(checkpoint: Checkpoint, removed = false): void {
    bus
      .emitTransient({
        type: 'checkpoint.updated',
        payload: { projectId: checkpoint.projectId, checkpoint, ...(removed ? { removed } : {}) },
      })
      .catch((error: unknown) =>
        logger.warn(
          { subsystem: 'checkpoints', checkpointId: checkpoint.id, reason: messageOf(error) },
          'could not announce a checkpoint',
        ),
      );
  }

  async function load(projectId: Id, id: Id): Promise<StoredCheckpoint> {
    const row = await checkpoints.get(scope, id);
    if (row === null || row.checkpoint.projectId !== projectId) throw notFound(`Checkpoint ${id}`);
    return row;
  }

  async function update(
    id: Id,
    patch: Parameters<CheckpointRepository['update']>[2],
  ): Promise<Checkpoint> {
    const updated = await checkpoints.update(scope, id, patch);
    if (updated === null) throw notFound(`Checkpoint ${id}`);
    announce(updated.checkpoint);
    return updated.checkpoint;
  }

  async function fail(id: Id, error: string): Promise<Checkpoint> {
    logger.warn({ subsystem: 'checkpoints', checkpointId: id, reason: error }, 'checkpoint failed');
    return update(id, { status: 'failed', error, updatedAt: now() });
  }

  /**
   * Recordings in this process, and the paths the person wrote meanwhile (D300 fix I3). After a
   * restart there are none: `recover` fails whatever was still recording.
   */
  const recordings = new Map<Id, { projectId: Id; personTouched: Set<string> }>();

  /** The after snapshot and the diff: its files, or dropped when nothing changed. */
  async function complete(id: Id): Promise<Checkpoint | undefined> {
    try {
      return await completeRecording(id);
    } finally {
      recordings.delete(id);
    }
  }

  async function completeRecording(id: Id): Promise<Checkpoint | undefined> {
    const row = await checkpoints.get(scope, id);
    if (row === null) return undefined;
    const { checkpoint } = row;
    if (checkpoint.status !== 'recording' || row.beforeRef === undefined) return checkpoint;
    try {
      const folder = await folderOf(checkpoint.projectId);
      const after = await store.snapshot(checkpoint.projectId, folder, {
        checkpointId: id,
        side: 'after',
      });
      const changed = await store.diff(checkpoint.projectId, row.beforeRef, after.commit);
      if (changed.length === 0) {
        await checkpoints.delete(scope, id);
        await store
          .drop(checkpoint.projectId, id)
          .catch((error: unknown) =>
            logger.warn(
              { subsystem: 'checkpoints', checkpointId: id, reason: messageOf(error) },
              'could not unpin a dropped checkpoint',
            ),
          );
        announce(checkpoint, true);
        return undefined;
      }
      const touched = recordings.get(id)?.personTouched;
      const files: CheckpointFile[] = changed
        .map((entry) => fileOf(entry, touched))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      return await update(id, {
        status: statusOf(files),
        files,
        skipped: [...new Set([...checkpoint.skipped, ...after.skipped])].sort(),
        afterRef: after.commit,
        updatedAt: now(),
      });
    } catch (error) {
      return fail(id, messageOf(error));
    }
  }

  return {
    async begin(projectId: string, meta: CheckpointMeta): Promise<CheckpointRecording> {
      const folder = await folderOf(projectId);
      const id = newId();
      const at = now();
      const base: Checkpoint = {
        id,
        projectId,
        kind: meta.kind,
        ...(meta.threadId === undefined ? {} : { threadId: meta.threadId }),
        ...(meta.messageId === undefined ? {} : { messageId: meta.messageId }),
        ...(meta.runId === undefined ? {} : { runId: meta.runId }),
        ...(meta.nodeId === undefined ? {} : { nodeId: meta.nodeId }),
        status: 'recording',
        files: [],
        skipped: [],
        createdAt: at,
        updatedAt: at,
      };
      let stored: StoredCheckpoint;
      try {
        const before = await store.snapshot(projectId, folder, {
          checkpointId: id,
          side: 'before',
        });
        stored = { checkpoint: { ...base, skipped: before.skipped }, beforeRef: before.commit };
      } catch (error) {
        // design §10: the agent still works; its changes just cannot be reverted
        const reason = messageOf(error);
        logger.warn({ subsystem: 'checkpoints', checkpointId: id, reason }, 'checkpoint failed');
        stored = { checkpoint: { ...base, status: 'failed', error: reason } };
      }
      await checkpoints.insert(scope, stored);
      if (stored.checkpoint.status === 'recording') {
        recordings.set(id, { projectId, personTouched: new Set() });
      }
      announce(stored.checkpoint);

      let finishing: Promise<Checkpoint | undefined> | undefined;
      return {
        id,
        finish: () => {
          finishing ??= serial(id, () => complete(id)).catch((error: unknown) => {
            logger.warn(
              { subsystem: 'checkpoints', checkpointId: id, reason: messageOf(error) },
              'could not finish a checkpoint',
            );
            return undefined;
          });
          return finishing;
        },
      };
    },

    async list(projectId) {
      const listed = (await checkpoints.listByProject(scope, projectId)).map(
        (row) => row.checkpoint,
      );
      // a stable partition: the repository's newest-first order holds inside each group
      return [
        ...listed.filter((checkpoint) => OPEN.has(checkpoint.status)),
        ...listed.filter((checkpoint) => !OPEN.has(checkpoint.status)),
      ];
    },

    async get(projectId, id) {
      return (await load(projectId, id)).checkpoint;
    },

    async fileDiff(projectId, id, path) {
      const row = await load(projectId, id);
      const file = row.checkpoint.files.find((candidate) => candidate.path === path);
      if (file === undefined) throw notFound(`${path} in checkpoint ${id}`);
      if (row.beforeRef === undefined || row.afterRef === undefined) {
        throw refused('This checkpoint has no snapshot to compare.');
      }
      if (file.binary) return { binary: true };
      let sides: [Uint8Array | undefined, Uint8Array | undefined];
      try {
        sides = await Promise.all([
          store.fileAt(projectId, row.beforeRef, path),
          store.fileAt(projectId, row.afterRef, path),
        ]);
      } catch (error) {
        if (isCheckpointUnavailableError(error)) throw checkpointsUnavailable(error.message);
        throw error;
      }
      const before = textOf(sides[0]);
      const after = textOf(sides[1]);
      if (before === null || after === null) return { binary: true };
      return {
        ...(before === undefined ? {} : { before }),
        ...(after === undefined ? {} : { after }),
        binary: false,
      };
    },

    act: (projectId, id, action) =>
      serial(id, async () => {
        const row = await load(projectId, id);
        const { checkpoint } = row;
        if (
          checkpoint.status === 'recording' ||
          checkpoint.status === 'failed' ||
          row.beforeRef === undefined ||
          row.afterRef === undefined
        ) {
          throw refused(
            checkpoint.status === 'recording'
              ? 'This checkpoint is still recording; wait for the agent to finish.'
              : 'This checkpoint failed, so its changes cannot be kept or reverted.',
          );
        }
        const wanted = action.paths === undefined ? undefined : new Set(action.paths);
        for (const path of wanted ?? []) {
          if (!checkpoint.files.some((file) => file.path === path)) {
            throw notFound(`${path} in checkpoint ${id}`);
          }
        }
        const targets = checkpoint.files.filter(
          (file) => file.state === 'pending' && (wanted === undefined || wanted.has(file.path)),
        );

        const decided = new Map<string, CheckpointFileState>();
        const conflicts: CheckpointConflictDetails['conflicts'] = [];
        let unavailable: string | undefined;
        // the person's files and the ones a snapshot left out are never reverted (D300 fix
        // C1, I3): Revert all passes over them, and naming one is refused with the reason
        if (action.action === 'revert' && wanted !== undefined) {
          for (const file of checkpoint.files) {
            if (wanted.has(file.path) && !DECIDABLE.has(file.state)) {
              conflicts.push({ path: file.path, message: notRevertedMessage(file) });
            }
          }
        }
        if (action.action === 'keep') {
          for (const file of targets) decided.set(file.path, 'kept');
        } else if (targets.length > 0) {
          const folder = await folderOf(projectId);
          for (const file of targets) {
            try {
              await store.revertFile(projectId, folder, row.beforeRef, row.afterRef, file.path);
              decided.set(file.path, 'reverted');
            } catch (error) {
              if (isCheckpointUnavailableError(error)) {
                unavailable = error.message;
                break;
              }
              const message =
                isCheckpointConflictError(error) || isWorkspaceFsError(error)
                  ? error.message
                  : `${file.path} could not be reverted: ${messageOf(error)}`;
              conflicts.push({ path: file.path, message });
            }
          }
        }

        let current = checkpoint;
        if (decided.size > 0) {
          const files = checkpoint.files.map((file) => {
            const state = decided.get(file.path);
            return state === undefined ? file : { ...file, state };
          });
          current = await update(id, { files, status: statusOf(files), updatedAt: now() });
        }
        if (unavailable !== undefined) throw checkpointsUnavailable(unavailable);
        if (conflicts.length > 0) throw checkpointConflict(conflicts);
        return current;
      }),

    async recover() {
      for (const row of await checkpoints.listByStatus(scope, 'recording')) {
        const { id, projectId } = row.checkpoint;
        // No after snapshot: what changed while the engine was down cannot be told apart from
        // the person's own work, so none of it is offered for revert (D300 fix I3).
        await serial(id, async () => {
          await fail(id, STOPPED_WHILE_RECORDING);
          await store.drop(projectId, id);
        }).catch((error: unknown) =>
          logger.warn(
            { subsystem: 'checkpoints', checkpointId: id, reason: messageOf(error) },
            'could not recover a checkpoint',
          ),
        );
      }
    },

    notePersonWrite(projectId, paths) {
      for (const recording of recordings.values()) {
        if (recording.projectId !== projectId) continue;
        for (const path of paths) recording.personTouched.add(path);
      }
    },
  };
}
