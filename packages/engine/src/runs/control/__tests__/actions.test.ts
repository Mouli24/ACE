import { RUN_ACTIONS, RUN_STATES, allowedRunActions, type RunAction, type RunState } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { HttpError } from '../../../gateway/errors.js';
import { assertRunAction, invalidRunState, isRunActionAllowed, withAllowedActions } from '../actions.js';

const RUN_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0RN55';
const run = (status: RunState) => ({ id: RUN_ID, status });

describe('TC-CTL-006 Allowed actions come from one table (FR-CTL-006, D76)', () => {
  it('writes `allowedActions` from the status, for every state', () => {
    for (const status of RUN_STATES) {
      expect(withAllowedActions({ status }).allowedActions).toEqual(allowedRunActions(status));
    }
  });

  it('never invents a second table — the answer is identical to the contract helper', () => {
    for (const status of RUN_STATES) {
      for (const action of RUN_ACTIONS) {
        expect(isRunActionAllowed({ status }, action)).toBe(allowedRunActions(status).includes(action));
      }
    }
  });

  it('reads why a run is blocked (D305) and whether it stays open (D323) from the run itself', () => {
    expect(withAllowedActions({ status: 'BLOCKED', blockedReason: 'LOOP_GUARD' }).allowedActions).toEqual([
      'resume',
      'stop',
    ]);
    const open = { id: RUN_ID, status: 'RUNNING' as RunState, domain: { stayOpen: true } };
    expect(isRunActionAllowed(open, 'end')).toBe(true);
    expect(isRunActionAllowed(run('RUNNING'), 'end')).toBe(false);
    expect(() => assertRunAction(run('RUNNING'), 'end')).toThrow('cannot be ended');
  });

  it('keeps every other field of the run untouched', () => {
    const before = { id: RUN_ID, status: 'RUNNING' as RunState, totals: { tokensIn: 3 } };
    expect(withAllowedActions(before)).toMatchObject({ id: RUN_ID, totals: { tokensIn: 3 } });
  });

  it('a RUNNING run may pause and stop, and nothing else', () => {
    expect(allowedRunActions('RUNNING')).toEqual(['pause', 'stop']);
    expect(() => assertRunAction(run('RUNNING'), 'pause')).not.toThrow();
    expect(() => assertRunAction(run('RUNNING'), 'stop')).not.toThrow();
    expect(() => assertRunAction(run('RUNNING'), 'resume')).toThrow(HttpError);
    expect(() => assertRunAction(run('RUNNING'), 'restart')).toThrow(HttpError);
  });

  it('a PAUSED run may resume and stop (D76: nodes may still be finishing)', () => {
    expect(() => assertRunAction(run('PAUSED'), 'resume')).not.toThrow();
    expect(() => assertRunAction(run('PAUSED'), 'stop')).not.toThrow();
    expect(() => assertRunAction(run('PAUSED'), 'pause')).toThrow(HttpError);
  });

  it('a finished run may only restart', () => {
    for (const status of ['COMPLETE', 'BLOCKED', 'HALTED'] as const) {
      expect(() => assertRunAction(run(status), 'restart')).not.toThrow();
      for (const action of ['pause', 'resume', 'stop'] as RunAction[]) {
        expect(() => assertRunAction(run(status), action)).toThrow(HttpError);
      }
    }
  });

  it('a PREFLIGHT run accepts nothing: there is not yet anything to control', () => {
    for (const action of RUN_ACTIONS) {
      expect(() => assertRunAction(run('PREFLIGHT'), action)).toThrow(HttpError);
    }
  });
});

describe('FR-CTL-006 the refusal is a 409 `invalid_run_state` (§2.5)', () => {
  it('answers 409 with the code §2.5 names', () => {
    const error = invalidRunState(run('HALTED'), 'pause');
    expect(error.status).toBe(409);
    expect(error.code).toBe('invalid_run_state');
  });

  it('says what cannot be done in plain words (NFR-USE-03)', () => {
    expect(invalidRunState(run('HALTED'), 'pause').message).toBe(
      'A run that is HALTED cannot be paused.',
    );
    expect(invalidRunState(run('RUNNING'), 'resume').message).toBe(
      'A run that is RUNNING cannot be resumed.',
    );
    expect(invalidRunState(run('COMPLETE'), 'stop').message).toBe(
      'A run that is COMPLETE cannot be stopped.',
    );
    expect(invalidRunState(run('RUNNING'), 'restart').message).toBe(
      'A run that is RUNNING cannot be restarted.',
    );
  });

  it('carries the status and the actions that are allowed, so a client can correct itself', () => {
    expect(invalidRunState(run('PAUSED'), 'pause').details).toEqual({
      runId: RUN_ID,
      status: 'PAUSED',
      allowedActions: ['resume', 'stop'],
    });
  });

  it('is a workflow error, not an auth or provider one (Arch §28)', () => {
    expect(invalidRunState(run('HALTED'), 'pause').kind).toBe('workflow');
  });
});
