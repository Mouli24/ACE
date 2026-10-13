import type { ProcessStartRequest, Project, ProjectScripts, TerminalTrust } from '@ace/contracts';
import type { QueryClient } from '@tanstack/react-query';

import { api } from '../../app/api';
import { getSocket } from '../../app/socket';
import { queryKeys } from '../../workflows/query-keys';
import { retainProjectScope } from '../project-scope';
import { processKeys } from '../terminal/hooks';
import { parseCheckOutput } from './check-parser';
import { setChecks, useProblemsStore } from './problems-store';

/** The label Run checks' process carries in the Terminal's Processes list. */
export const CHECKS_LABEL = 'Checks';
/** How often a run that missed its `process.exited` frame asks the engine whether it ended. */
const POLL_MS = 1_000;

/** Why Run checks cannot start for this project, or `undefined` when it can. */
export function checksBlocked(
  project: Pick<Project, 'checkCommand' | 'terminal'> | undefined,
): 'loading' | 'no_command' | 'terminal_off' | undefined {
  if (project === undefined) return 'loading';
  if (project.checkCommand === undefined || project.checkCommand === null) return 'no_command';
  if ((project.terminal ?? 'on') === 'off') return 'terminal_off';
  return undefined;
}

/**
 * What the engine is asked to start (D301's trust levels). A command that is exactly a root
 * package.json script's name runs as that script at any level. Under `scripts`, the only form the
 * engine allows, `<pm> run <name>` and `<pm> <name>` naming a script run as it too. Anything else
 * goes as a typed command — which `scripts` refuses, and that refusal is what the person reads.
 */
export function checkStartRequest(
  command: string,
  trust: TerminalTrust,
  scripts: ProjectScripts | undefined,
): ProcessStartRequest {
  const names = new Set(scripts?.scripts.map((script) => script.name) ?? []);
  const trimmed = command.trim();
  if (names.has(trimmed)) return { script: trimmed, label: CHECKS_LABEL };
  const viaManager = /^(?:npm|pnpm|yarn|bun)(?: run)? (\S+)$/.exec(trimmed)?.[1];
  if (trust === 'scripts' && viaManager !== undefined && names.has(viaManager)) {
    return { script: viaManager, label: CHECKS_LABEL };
  }
  return { command: trimmed, label: CHECKS_LABEL };
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Resolves once the process has ended: on its `process.exited` frame (D301), or — when that frame
 * was missed, or came before anyone listened — on the engine saying so when asked.
 */
function ended(projectId: string, processId: string): Promise<void> {
  return new Promise((settle) => {
    const socket = getSocket();
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const listening: { off?: () => void } = {};
    const finish = (): void => {
      if (done) return;
      done = true;
      listening.off?.();
      if (timer !== undefined) clearTimeout(timer);
      settle();
    };
    listening.off = socket?.on('process.exited', (payload) => {
      if (payload.projectId === projectId && payload.processId === processId) finish();
    });
    const ask = async (): Promise<void> => {
      try {
        const detail = await api().getProcess(projectId, processId);
        if (detail.status !== 'running') return finish();
      } catch {
        // gone (the engine restarted): nothing more will come
        return finish();
      }
      if (!done) timer = setTimeout(() => void ask(), POLL_MS);
    };
    void ask();
  });
}

/**
 * Run checks (D299 Phase 4, design §6.4): the project's check command as a process at the project
 * root, labelled "Checks" — it shows in the Terminal's Processes list like any other — then, once
 * it has exited, its output read back and parsed into the `checks` slice of Problems, replacing
 * the last run. A start the engine refuses (trust `scripts` and a command that is not a script)
 * lands in the slice as `failed` with the engine's own words. One run at a time per project.
 */
export async function runChecks(projectId: string, queryClient: QueryClient): Promise<void> {
  if (useProblemsStore.getState().checks[projectId]?.status === 'running') return;
  let project: Project;
  try {
    project = await queryClient.ensureQueryData({
      queryKey: queryKeys.project(projectId),
      queryFn: () => api().getProject(projectId),
    });
  } catch {
    return;
  }
  if (checksBlocked(project) !== undefined) return;
  const command = project.checkCommand ?? '';
  const trust = project.terminal ?? 'on';
  const startedAt = new Date().toISOString();
  const previous = useProblemsStore.getState().checks[projectId]?.problems ?? [];
  setChecks(projectId, { status: 'running', command, startedAt, problems: previous });

  const socket = getSocket();
  const release = socket === undefined ? undefined : retainProjectScope(socket, projectId);
  try {
    const scripts = await queryClient
      .fetchQuery({
        queryKey: processKeys.scripts(projectId),
        queryFn: () => api().projectScripts(projectId),
        staleTime: 30_000,
      })
      .catch(() => undefined);
    let processId: string;
    try {
      ({ processId } = await api().startProcess(
        projectId,
        checkStartRequest(command, trust, scripts),
      ));
    } catch (error) {
      setChecks(projectId, {
        status: 'failed',
        command,
        startedAt,
        finishedAt: new Date().toISOString(),
        problems: [],
        error: messageOf(error),
      });
      return;
    }
    void queryClient.invalidateQueries({ queryKey: processKeys.list(projectId) });
    setChecks(projectId, { status: 'running', command, processId, startedAt, problems: previous });

    await ended(projectId, processId);
    const detail = await api().getProcess(projectId, processId);
    setChecks(projectId, {
      status: detail.status === 'failed' ? 'failed' : 'done',
      command,
      processId,
      startedAt,
      finishedAt: detail.endedAt ?? new Date().toISOString(),
      exitCode: detail.exitCode,
      problems: parseCheckOutput(detail.output, project.folderPath),
      ...(detail.status === 'failed' ? { error: 'The check command could not start.' } : {}),
    });
  } catch (error) {
    setChecks(projectId, {
      status: 'failed',
      command,
      startedAt,
      finishedAt: new Date().toISOString(),
      problems: [],
      error: messageOf(error),
    });
  } finally {
    release?.();
    void queryClient.invalidateQueries({ queryKey: processKeys.list(projectId) });
  }
}
