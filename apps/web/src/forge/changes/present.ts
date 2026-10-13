import type { Checkpoint, CheckpointFile, CheckpointStatus } from '@ace/contracts';
import { AceApiError } from '@ace/sdk';

/*
 * How a checkpoint reads in Forge's Changes view and the chat's Changes card (D300, design §5.3,
 * §10): where it came from, its status in words, and the note a failed one carries.
 */

/** "Chat with Writer", or "Run 7KQ4R7" — the last six characters of the run's id. */
export function sourceLabel(
  checkpoint: Checkpoint,
  nodeName: (nodeId: string) => string | undefined = () => undefined,
): string {
  if (checkpoint.kind === 'run') {
    return checkpoint.runId === undefined ? 'Run' : `Run ${checkpoint.runId.slice(-6)}`;
  }
  const name = checkpoint.nodeId === undefined ? undefined : nodeName(checkpoint.nodeId);
  return `Chat with ${name ?? 'an agent'}`;
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

/** The theme's file-change words for a decided file. */
export const fileStateLabel = (file: CheckpointFile): string =>
  file.state === 'kept' ? 'kept' : file.state === 'reverted' ? 'reverted' : '';

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
