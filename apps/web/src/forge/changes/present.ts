import type {
  Checkpoint,
  CheckpointFile,
  CheckpointStatus,
  CheckpointUncapturedReason,
} from '@ace/contracts';
import { AceApiError } from '@ace/sdk';

/*
 * How a checkpoint reads in Forge's Changes view and the chat's Changes card (D300, design §5.3,
 * §10): where it came from, its status in words, and the note a failed one carries.
 */

/**
 * "Chat with Writer", "Run 7KQ4R7" (the last six characters of the run's id), or — one writing
 * node's step of a run (PG-5.1) — "Run 7KQ4R7 · Writer".
 */
export function sourceLabel(
  checkpoint: Checkpoint,
  nodeName: (nodeId: string) => string | undefined = () => undefined,
): string {
  const name = checkpoint.nodeId === undefined ? undefined : nodeName(checkpoint.nodeId);
  if (checkpoint.kind === 'run') {
    const run = checkpoint.runId === undefined ? 'Run' : `Run ${checkpoint.runId.slice(-6)}`;
    return checkpoint.nodeId === undefined ? run : `${run} · ${name ?? 'a node'}`;
  }
  return `Chat with ${name ?? 'an agent'}`;
}

/** PG-5.1: a run checkpoint's way back to its run, on that node when it is one node's step. */
export function runLink(checkpoint: Checkpoint): string | undefined {
  if (checkpoint.kind !== 'run' || checkpoint.runId === undefined) return undefined;
  const node =
    checkpoint.nodeId === undefined ? '' : `?node=${encodeURIComponent(checkpoint.nodeId)}`;
  return `/runs/${checkpoint.runId}${node}`;
}

export const STATUS_LABEL: Record<CheckpointStatus, string> = {
  recording: 'Recording…',
  pending: 'To review',
  kept: 'Kept',
  reverted: 'Reverted',
  partial: 'Partly reverted',
  failed: 'Not revertible',
};

/** Design §10's words for a checkpoint that could not be taken. */
export const failureNote = (checkpoint: Checkpoint): string =>
  `Changes were made but can't be reverted: ${checkpoint.error ?? 'the folder could not be snapshotted'}`;

/** The theme's file-change words for a file that is no longer waiting. */
export const fileStateLabel = (file: CheckpointFile): string =>
  file.state === 'kept'
    ? 'kept'
    : file.state === 'reverted'
      ? 'reverted'
      : file.state === 'person'
        ? 'yours'
        : file.state === 'not_revertible'
          ? 'not captured'
          : '';

const UNCAPTURED_WORDS: Readonly<Record<CheckpointUncapturedReason, string>> = {
  ignored: 'ignored',
  too_large: 'over 5 MB',
  unreadable: 'unreadable',
  vanished: 'it vanished while being captured',
};

/**
 * Why a listed file has no Revert (D300 fix C1, I3): the person edited it while the agent worked,
 * or a snapshot could not capture it. `undefined` for every other file.
 */
export function fileNote(file: CheckpointFile): string | undefined {
  if (file.state === 'person') return 'You edited this during the session';
  if (file.state !== 'not_revertible') return undefined;
  return `ACE could not capture this file (${UNCAPTURED_WORDS[file.reason ?? 'unreadable']}), so it can't be reverted`;
}

export const pendingFiles = (checkpoint: Checkpoint): CheckpointFile[] =>
  checkpoint.files.filter((file) => file.state === 'pending');

/** Checkpoints leave out ignored folders and files over 5 MB (known limitation, design §5.1). */
export const COVERAGE_NOTE = 'Ignored folders and files over 5 MB are not checkpointed.';

/** An action's failure in words, unless it is a refused revert: that one shows on its file. */
export function actionFailure(error: unknown): string | undefined {
  if (error === null || error === undefined) return undefined;
  if (AceApiError.is(error) && error.code === 'checkpoint_conflict') return undefined;
  return error instanceof Error ? error.message : String(error);
}
