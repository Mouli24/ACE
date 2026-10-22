import { HttpError } from '../gateway/errors.js';

/*
 * The terminal's refusals (D301, design §6.3). Each message is what the person reads in their
 * terminal tab, so it says what to do next. The mock engine repeats them word for word.
 */

export const terminalDisabled = (): HttpError =>
  new HttpError(
    'invalid_config',
    'terminal_disabled',
    "The terminal is off for this project. Turn it on in the project's settings to run commands.",
    undefined,
    false,
  );

export const terminalRestricted = (): HttpError =>
  new HttpError(
    'invalid_config',
    'terminal_restricted',
    "This project runs only its own package.json scripts in the terminal. Pick a script, or allow every command in the project's settings.",
    undefined,
    false,
  );

export const processLimit = (max: number): HttpError =>
  new HttpError(
    'workflow',
    'process_limit',
    `This project already runs ${max} processes. Stop one before starting another.`,
    { max },
    false,
  );

export const processNotRunning = (processId: string): HttpError =>
  new HttpError(
    'workflow',
    'process_not_running',
    'That process has finished, so it reads no more input.',
    { processId },
    false,
  );

/** A script name a shell would read as more than one word is never handed to a shell. */
export const unsafeScriptName = (name: string): HttpError =>
  new HttpError(
    'invalid_config',
    'validation_failed',
    `The script "${name}" has a name a shell would read as more than a name. Rename it in package.json to run it here.`,
    { script: name },
    false,
  );

/** The engine is shutting down (FR-SYS-008): nothing new starts while the last ones are killed. */
export const engineStopping = (): HttpError =>
  new HttpError(
    'workflow',
    'engine_stopping',
    'The engine is shutting down; the command was not started.',
    undefined,
    false,
  );

/**
 * PG-5.3 (D361): an agent's command is shown in Forge read-only — it reads no input from the
 * terminal and is not stopped there. Stopping its run stops it (D349).
 */
/** Task 14: Stop on a foreground agent command; only its run can end it. */
export const agentCommandStopRun = (processId: string): HttpError =>
  new HttpError(
    'invalid_config',
    'validation_failed',
    'Stop the run to stop this command.',
    { processId },
    false,
  );

export const agentCommandReadOnly = (processId: string): HttpError =>
  new HttpError(
    'invalid_config',
    'validation_failed',
    "This command belongs to an agent's run, so it is read-only here. Stop the run to stop it.",
    { processId },
    false,
  );
