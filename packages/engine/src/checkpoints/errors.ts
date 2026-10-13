import type { CheckpointConflictDetails } from '@ace/contracts';

import { HttpError } from '../gateway/errors.js';

/*
 * The checkpoints' refusals (D300, design §5.3, §10). Each message is what the person reads beside
 * the file or the checkpoint, so it says what to do next. The mock engine repeats them word for word.
 */

/** A revert that would lose a later change: every such path, each with its own message. */
export const checkpointConflict = (conflicts: CheckpointConflictDetails['conflicts']): HttpError =>
  new HttpError(
    'workflow',
    'checkpoint_conflict',
    conflicts.length === 1
      ? (conflicts[0]?.message ?? '')
      : `${conflicts.length} files changed after the agent's edit; review them before reverting.`,
    { conflicts } satisfies CheckpointConflictDetails,
    false,
  );

/** git is missing or failed, so nothing can be reviewed or reverted right now. */
export const checkpointsUnavailable = (reason: string): HttpError =>
  new HttpError(
    'workflow',
    'checkpoints_unavailable',
    `Checkpoints are unavailable: ${reason}`,
    undefined,
    true,
  );
