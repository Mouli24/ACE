import { allowedRunActions, type Run, type RunAction, type RunState } from '@ace/contracts';

import { HttpError } from '../../gateway/errors.js';

/**
 * Which controls a run accepts, and the refusal when it does not (FR-CTL-006, D76).
 *
 * The table is `allowedRunActions` in `@ace/contracts` and there is deliberately no second copy of
 * it here: the engine writes it onto the row, answers 409 outside it, and the web app reads the
 * field. Three places, one table.
 */

const PAST_TENSE: Readonly<Record<RunAction, string>> = {
  pause: 'paused',
  resume: 'resumed',
  stop: 'stopped',
  restart: 'restarted',
};

/** FR-CTL-006: the run as the API returns it, with `allowedActions` filled in from its status. */
export function withAllowedActions<T extends { status: RunState }>(
  run: T,
): T & { allowedActions: RunAction[] } {
  return { ...run, allowedActions: allowedRunActions(run.status) };
}

export function isRunActionAllowed(status: RunState, action: RunAction): boolean {
  return allowedRunActions(status).includes(action);
}

/**
 * §2.5: an action the run's state does not allow is a 409 `invalid_run_state`. The refusal carries
 * the status and the actions that *are* allowed, so a client that raced the run to it can correct
 * its buttons from the error alone.
 */
export function invalidRunState(run: Pick<Run, 'id' | 'status'>, action: RunAction): HttpError {
  return new HttpError(
    'workflow',
    'invalid_run_state',
    `A run that is ${run.status} cannot be ${PAST_TENSE[action]}.`,
    { runId: run.id, status: run.status, allowedActions: allowedRunActions(run.status) },
  );
}

/** Throws the 409 unless this run allows this action. */
export function assertRunAction(run: Pick<Run, 'id' | 'status'>, action: RunAction): void {
  if (!isRunActionAllowed(run.status, action)) throw invalidRunState(run, action);
}
