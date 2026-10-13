import type {
  Checkpoint,
  CheckpointAction,
  CheckpointConflictDetails,
  CheckpointFile,
  CheckpointFileDiff,
  CheckpointFileState,
  CheckpointKind,
  CheckpointStatus,
} from '@ace/contracts';

import { newId } from '../lib/ulid';
import type { MockDb } from './db';

/**
 * Checkpoints on the mock engine (D300, design §5), so the web app and its tests run with zero env
 * vars. Nothing is snapshotted: a seeded checkpoint carries each file's before and after text, and
 * its after text is what the mock folder holds. Keep, revert and the "changed since" refusal follow
 * the engine's rules, word for word. In memory, like the mock's processes: a reload is a restart.
 */

export class MockCheckpointError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/** The engine's refusals, word for word (`packages/engine/src/ports/checkpoints.ts`, `errors.ts`). */
export const MOCK_CHECKPOINT_MESSAGES = {
  conflict: (path: string) => `${path} changed after the agent's edit; review it before reverting`,
  conflicts: (count: number) =>
    `${count} files changed after the agent's edit; review them before reverting.`,
  recording: 'This checkpoint is still recording; wait for the agent to finish.',
  failed: 'This checkpoint failed, so its changes cannot be kept or reverted.',
} as const;

/** One file of a seeded checkpoint: absent `before` is a file the agent created. */
export interface SeedCheckpointFile {
  path: string;
  before?: string;
  /** Absent: the agent deleted it. */
  after?: string;
  binary?: boolean;
}

export interface SeedCheckpointOptions {
  kind?: CheckpointKind;
  threadId?: string;
  messageId?: string;
  runId?: string;
  nodeId?: string;
  status?: Extract<CheckpointStatus, 'recording' | 'pending' | 'failed'>;
  error?: string;
  skipped?: string[];
  createdAt?: string;
}

interface Sides {
  before?: string;
  after?: string;
}

const lines = (text: string | undefined): string[] =>
  text === undefined || text === '' ? [] : text.replace(/\n$/, '').split('\n');

/** Lines only one side has, counted as a multiset: close enough to git's numstat for the mock. */
function counts(before: string | undefined, after: string | undefined) {
  const left = new Map<string, number>();
  for (const line of lines(before)) left.set(line, (left.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of lines(after)) {
    const remaining = left.get(line) ?? 0;
    if (remaining > 0) left.set(line, remaining - 1);
    else additions += 1;
  }
  const deletions = [...left.values()].reduce((sum, count) => sum + count, 0);
  return { additions, deletions };
}

function statusOf(files: readonly CheckpointFile[]): CheckpointStatus {
  if (files.some((file) => file.state === 'pending')) return 'pending';
  if (files.every((file) => file.state === 'kept')) return 'kept';
  if (files.every((file) => file.state === 'reverted')) return 'reverted';
  return 'partial';
}

const OPEN: ReadonlySet<CheckpointStatus> = new Set(['recording', 'pending']);

export class MockCheckpoints {
  private readonly checkpoints = new Map<string, Checkpoint>();
  private readonly sides = new Map<string, Map<string, Sides>>();

  constructor(private readonly db: MockDb) {}

  reset(): void {
    this.checkpoints.clear();
    this.sides.clear();
  }

  /** Open ones first, then the rest; newest first in each — as the engine lists them. */
  list(projectId: string): Checkpoint[] {
    const mine = [...this.checkpoints.values()]
      .filter((checkpoint) => checkpoint.projectId === projectId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    return [
      ...mine.filter((checkpoint) => OPEN.has(checkpoint.status)),
      ...mine.filter((checkpoint) => !OPEN.has(checkpoint.status)),
    ];
  }

  get(projectId: string, id: string): Checkpoint {
    const checkpoint = this.checkpoints.get(id);
    if (checkpoint === undefined || checkpoint.projectId !== projectId) {
      throw new MockCheckpointError(404, 'not_found', `Checkpoint ${id} was not found.`);
    }
    return checkpoint;
  }

  diff(projectId: string, id: string, path: string): CheckpointFileDiff {
    const checkpoint = this.get(projectId, id);
    const file = checkpoint.files.find((candidate) => candidate.path === path);
    if (file === undefined) {
      throw new MockCheckpointError(404, 'not_found', `${path} in checkpoint ${id} was not found.`);
    }
    if (file.binary) return { binary: true };
    const { before, after } = this.sides.get(id)?.get(path) ?? {};
    return {
      ...(before === undefined ? {} : { before }),
      ...(after === undefined ? {} : { after }),
      binary: false,
    };
  }

  act(projectId: string, id: string, action: CheckpointAction): Checkpoint {
    const checkpoint = this.get(projectId, id);
    if (checkpoint.status === 'recording' || checkpoint.status === 'failed') {
      throw new MockCheckpointError(
        400,
        'validation_failed',
        checkpoint.status === 'recording'
          ? MOCK_CHECKPOINT_MESSAGES.recording
          : MOCK_CHECKPOINT_MESSAGES.failed,
      );
    }
    const wanted = action.paths === undefined ? undefined : new Set(action.paths);
    for (const path of wanted ?? []) {
      if (!checkpoint.files.some((file) => file.path === path)) {
        throw new MockCheckpointError(
          404,
          'not_found',
          `${path} in checkpoint ${id} was not found.`,
        );
      }
    }
    const decided = new Map<string, CheckpointFileState>();
    const conflicts: CheckpointConflictDetails['conflicts'] = [];
    for (const file of checkpoint.files) {
      if (file.state !== 'pending' || (wanted !== undefined && !wanted.has(file.path))) continue;
      if (action.action === 'keep') {
        decided.set(file.path, 'kept');
        continue;
      }
      const { before, after } = this.sides.get(id)?.get(file.path) ?? {};
      const entry = this.db.filesOf(projectId)[file.path];
      const now = entry?.kind === 'file' ? entry.content : undefined;
      if (now !== after) {
        conflicts.push({ path: file.path, message: MOCK_CHECKPOINT_MESSAGES.conflict(file.path) });
        continue;
      }
      if (before === undefined) {
        if (now !== undefined) this.db.deleteFileExternally(projectId, file.path);
      } else {
        this.db.writeFileExternally(projectId, file.path, before);
      }
      decided.set(file.path, 'reverted');
    }
    let current = checkpoint;
    if (decided.size > 0) {
      const files = checkpoint.files.map((file) => {
        const state = decided.get(file.path);
        return state === undefined ? file : { ...file, state };
      });
      current = this.save({
        ...checkpoint,
        files,
        status: statusOf(files),
        updatedAt: new Date().toISOString(),
      });
    }
    if (conflicts.length > 0) {
      throw new MockCheckpointError(
        409,
        'checkpoint_conflict',
        conflicts.length === 1
          ? (conflicts[0]?.message ?? '')
          : MOCK_CHECKPOINT_MESSAGES.conflicts(conflicts.length),
        { conflicts },
      );
    }
    return current;
  }

  /**
   * A checkpoint as an agent's turn would leave it (`__aceMock.seedCheckpoint`): the folder is
   * made to hold each file's after text, quietly, and the checkpoint is announced.
   */
  seed(
    projectId: string,
    files: readonly SeedCheckpointFile[],
    options: SeedCheckpointOptions = {},
  ): Checkpoint {
    const id = newId();
    const at = options.createdAt ?? new Date().toISOString();
    const status = options.status ?? 'pending';
    const sides = new Map<string, Sides>();
    const fs = this.db.filesOf(projectId);
    const present: Record<string, string> = {};
    for (const file of files) {
      sides.set(file.path, {
        ...(file.before === undefined ? {} : { before: file.before }),
        ...(file.after === undefined ? {} : { after: file.after }),
      });
      if (file.after === undefined) delete fs[file.path];
      else present[file.path] = file.after;
    }
    this.db.seedFiles(projectId, present);
    this.sides.set(id, sides);
    return this.save({
      id,
      projectId,
      kind: options.kind ?? 'chat',
      ...(options.threadId === undefined ? {} : { threadId: options.threadId }),
      ...(options.messageId === undefined ? {} : { messageId: options.messageId }),
      ...(options.runId === undefined ? {} : { runId: options.runId }),
      ...(options.nodeId === undefined ? {} : { nodeId: options.nodeId }),
      status,
      files:
        status === 'pending'
          ? files.map((file) => ({
              path: file.path,
              change:
                file.before === undefined
                  ? ('added' as const)
                  : file.after === undefined
                    ? ('deleted' as const)
                    : ('modified' as const),
              ...(file.binary === true
                ? { additions: 0, deletions: 0 }
                : counts(file.before, file.after)),
              binary: file.binary === true,
              state: 'pending' as const,
            }))
          : [],
      skipped: options.skipped ?? [],
      ...(options.error === undefined ? {} : { error: options.error }),
      createdAt: at,
      updatedAt: at,
    });
  }

  private save(checkpoint: Checkpoint): Checkpoint {
    this.checkpoints.set(checkpoint.id, checkpoint);
    this.db.emit({
      type: 'checkpoint.updated',
      payload: { projectId: checkpoint.projectId, checkpoint },
      scope: 'project',
      projectId: checkpoint.projectId,
      transient: true,
    });
    return checkpoint;
  }
}
