import { describe, expect, it } from 'vitest';

import { db, installMockServer, installMockSocket, processes, queryClient } from '../../test/app';
import { useProblemsStore } from './problems-store';
import { CHECKS_LABEL, checkStartRequest, checksBlocked, runChecks } from './run-checks';

installMockServer();
installMockSocket();

const checks = (projectId: string) => useProblemsStore.getState().checks[projectId];
const SCRIPTS = {
  packageManager: 'pnpm' as const,
  scripts: [
    { name: 'typecheck', command: 'tsc --noEmit' },
    { name: 'lint', command: 'eslint .' },
  ],
};

describe('D299 Phase 4 what Run checks asks the engine to start', () => {
  it('runs a command that names a script as that script, at any trust level', () => {
    expect(checkStartRequest('typecheck', 'on', SCRIPTS)).toEqual({
      script: 'typecheck',
      label: CHECKS_LABEL,
    });
    expect(checkStartRequest(' lint ', 'scripts', SCRIPTS)).toEqual({
      script: 'lint',
      label: 'Checks',
    });
  });

  it('under scripts, reads `<pm> run <name>` and `<pm> <name>` as the script; under on, runs it as typed', () => {
    expect(checkStartRequest('pnpm run typecheck', 'scripts', SCRIPTS)).toEqual({
      script: 'typecheck',
      label: 'Checks',
    });
    expect(checkStartRequest('npm lint', 'scripts', SCRIPTS)).toEqual({
      script: 'lint',
      label: 'Checks',
    });
    expect(checkStartRequest('pnpm run typecheck', 'on', SCRIPTS)).toEqual({
      command: 'pnpm run typecheck',
      label: 'Checks',
    });
    // not a script: sent as typed, and the engine's refusal is what the person reads
    expect(checkStartRequest('pnpm tsc --noEmit', 'scripts', SCRIPTS)).toEqual({
      command: 'pnpm tsc --noEmit',
      label: 'Checks',
    });
    expect(checkStartRequest('typecheck', 'on', undefined)).toEqual({
      command: 'typecheck',
      label: 'Checks',
    });
  });

  it('is blocked without a command and with the terminal off', () => {
    expect(checksBlocked(undefined)).toBe('loading');
    expect(checksBlocked({})).toBe('no_command');
    expect(checksBlocked({ checkCommand: null })).toBe('no_command');
    expect(checksBlocked({ checkCommand: 'x', terminal: 'off' })).toBe('terminal_off');
    expect(checksBlocked({ checkCommand: 'x', terminal: 'scripts' })).toBeUndefined();
    expect(checksBlocked({ checkCommand: 'x' })).toBeUndefined();
  });
});

describe('D299 Phase 4 runChecks', () => {
  it('starts the command as a "Checks" process, waits for its exit, and parses its output into the slice', async () => {
    const project = db.createProject({ name: 'Shop' });
    db.updateProject(project.id, {
      checkCommand: 'echo src/app.ts(2,3): error TS2322: Type is wrong.',
    });

    await runChecks(project.id, queryClient);

    const run = checks(project.id);
    expect(run).toMatchObject({
      status: 'done',
      command: 'echo src/app.ts(2,3): error TS2322: Type is wrong.',
      exitCode: 0,
      problems: [
        {
          path: 'src/app.ts',
          line: 2,
          column: 3,
          severity: 'error',
          message: 'Type is wrong.',
          source: 'tsc',
          code: 'TS2322',
        },
      ],
    });
    expect(run?.finishedAt).toBeDefined();
    // it is a process like any other, in the Terminal's list
    const listed = processes.list(project.id);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: run?.processId, label: 'Checks', status: 'exited' });
  });

  it('under trust scripts, runs a script check command as the script', async () => {
    const project = db.createProject({ name: 'Shop' });
    db.seedFiles(project.id, {
      'package.json': JSON.stringify({ scripts: { check: 'echo lib/x.ts:4:2: warning: meh' } }),
    });
    db.updateProject(project.id, { checkCommand: 'check', terminal: 'scripts' });

    await runChecks(project.id, queryClient);

    expect(checks(project.id)).toMatchObject({
      status: 'done',
      problems: [{ path: 'lib/x.ts', line: 4, column: 2, severity: 'warning', source: 'check' }],
    });
  });

  it('under trust scripts, a typed command is refused, and the slice says so in the engine’s words', async () => {
    const project = db.createProject({ name: 'Shop' });
    db.updateProject(project.id, { checkCommand: 'pnpm tsc --noEmit', terminal: 'scripts' });

    await runChecks(project.id, queryClient);

    expect(checks(project.id)).toMatchObject({ status: 'failed', problems: [] });
    expect(checks(project.id)?.error).toMatch(/only its own package\.json scripts/);
    expect(processes.list(project.id)).toEqual([]);
  });

  it('does nothing with the terminal off or no command', async () => {
    const off = db.createProject({ name: 'Off' });
    db.updateProject(off.id, { checkCommand: 'echo x', terminal: 'off' });
    const none = db.createProject({ name: 'None' });
    await runChecks(off.id, queryClient);
    await runChecks(none.id, queryClient);
    expect(checks(off.id)).toBeUndefined();
    expect(checks(none.id)).toBeUndefined();
    expect(processes.list(off.id)).toEqual([]);
  });

  it('a new run replaces the last one', async () => {
    const project = db.createProject({ name: 'Shop' });
    db.updateProject(project.id, { checkCommand: 'echo a.ts:1:1: error: first' });
    await runChecks(project.id, queryClient);
    expect(checks(project.id)?.problems.map((problem) => problem.message)).toEqual(['first']);

    db.updateProject(project.id, { checkCommand: 'echo clean' });
    queryClient.removeQueries();
    await runChecks(project.id, queryClient);
    expect(checks(project.id)).toMatchObject({ status: 'done', problems: [] });
  });
});
