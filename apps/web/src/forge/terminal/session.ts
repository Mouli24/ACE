import type { PackageManager, ProcessStartRequest, ProcessSummary } from '@ace/contracts';
import type { QueryClient } from '@tanstack/react-query';

import { api } from '../../app/api';
import { parseBuiltin, resolveCd } from './builtins';
import { processKeys } from './hooks';
import { busyLine, feed, settleLine, type LineAction } from './line-discipline';
import { reattach } from './process-events';
import { errorLine, tabOf, useTerminalStore } from './terminal-store';

/**
 * What a terminal tab does with what is typed (D301, design §6.3): the line discipline echoes at
 * once, then each action runs in order, per tab — so input typed while a start is still in flight
 * waits for the process it is meant for.
 */

const queues = new Map<string, Promise<void>>();

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Runs `work` after everything this tab was already doing. A refusal is printed where it happens
 * (`startInTab`, `changeDirectory`); a step that still throws is a bug, so it is printed in the tab
 * too, never swallowed, and a tab left waiting on a run that never attached gets its prompt back.
 * The queue goes on either way.
 */
export function enqueue(
  projectId: string,
  tabId: string,
  work: () => Promise<void>,
): Promise<void> {
  const key = `${projectId}\u0000${tabId}`;
  const next = (queues.get(key) ?? Promise.resolve()).then(work).catch((error: unknown) => {
    const store = useTerminalStore.getState();
    store.write(projectId, tabId, errorLine(`Terminal error: ${messageOf(error)}`));
    const tab = tabOf(projectId, tabId);
    if (tab !== undefined && tab.processId === undefined && tab.line.busy)
      store.idle(projectId, tabId);
  });
  queues.set(key, next);
  // A queue that has gone idle is dropped, so closed tabs leave nothing behind.
  void next.then(() => {
    if (queues.get(key) === next) queues.delete(key);
  });
  return next;
}

/** Starts a process for the tab and attaches it; a refusal or failure is printed in the tab (§10). */
export async function startInTab(
  projectId: string,
  tabId: string,
  request: ProcessStartRequest,
  queryClient: QueryClient,
): Promise<void> {
  const store = useTerminalStore.getState();
  try {
    const { processId } = await api().startProcess(projectId, request);
    store.attach(projectId, tabId, processId);
  } catch (error) {
    store.write(projectId, tabId, errorLine(messageOf(error)));
    store.idle(projectId, tabId);
  } finally {
    void queryClient.invalidateQueries({ queryKey: processKeys.list(projectId) });
  }
}

async function changeDirectory(
  projectId: string,
  tabId: string,
  arg: string | undefined,
): Promise<void> {
  const store = useTerminalStore.getState();
  const tab = tabOf(projectId, tabId);
  if (tab === undefined) return;
  if (arg === undefined) {
    store.write(projectId, tabId, `${tab.cwd === '' ? '~' : tab.cwd}\r\n`);
    store.idle(projectId, tabId);
    return;
  }
  const target = resolveCd(tab.cwd, arg);
  try {
    // Listing it is the check: the files API confines it as the engine confines a process (FR-GIT-008).
    await api().listFolder(projectId, target);
    store.setCwd(projectId, tabId, target);
  } catch (error) {
    store.write(projectId, tabId, errorLine(`cd: ${arg}: ${messageOf(error)}`));
  }
  store.idle(projectId, tabId);
}

async function runLine(
  projectId: string,
  tabId: string,
  line: string,
  queryClient: QueryClient,
): Promise<void> {
  const builtin = parseBuiltin(line);
  if (builtin?.kind === 'clear') {
    const store = useTerminalStore.getState();
    store.clearScreen(projectId, tabId);
    store.idle(projectId, tabId);
    return;
  }
  if (builtin?.kind === 'cd') {
    await changeDirectory(projectId, tabId, builtin.arg);
    return;
  }
  const cwd = tabOf(projectId, tabId)?.cwd ?? '';
  await startInTab(projectId, tabId, { command: line, cwd }, queryClient);
}

async function perform(
  projectId: string,
  tabId: string,
  action: LineAction,
  queryClient: QueryClient,
): Promise<void> {
  const store = useTerminalStore.getState();
  switch (action.kind) {
    case 'prompt':
      store.idle(projectId, tabId);
      return;
    case 'run':
      await runLine(projectId, tabId, action.line, queryClient);
      return;
    case 'input': {
      const tab = tabOf(projectId, tabId);
      if (tab === undefined) return;
      const processId = tab.processId;
      if (processId === undefined) {
        // Typed ahead, and nothing is attached: a built-in ran, the start was refused, or the
        // process had already ended. As in a real shell, what no program read goes to the shell:
        // the line is entered at the prompt the tab is back at, exactly as Enter there runs it
        // (design §10: never swallowed). The settled state is not busy, so this never loops.
        const step = feed(settleLine(tab.line), action.data);
        store.setLine(projectId, tabId, step.state);
        store.write(projectId, tabId, step.echo);
        for (const next of step.actions) await perform(projectId, tabId, next, queryClient);
        return;
      }
      try {
        await api().processInput(projectId, processId, action.data);
      } catch {
        // It ended in the meantime; its process.exited says so.
      }
      return;
    }
    case 'stop': {
      const processId = tabOf(projectId, tabId)?.processId;
      if (processId === undefined) return;
      try {
        await api().stopProcess(projectId, processId);
      } catch (error) {
        store.write(projectId, tabId, errorLine(`Could not stop it: ${messageOf(error)}`));
      }
      return;
    }
  }
}

/**
 * What xterm reported the person typed. Echoes at once; answers once every action it caused has
 * run (tests await it).
 */
export function typed(
  projectId: string,
  tabId: string,
  data: string,
  queryClient: QueryClient,
): Promise<void> {
  const tab = tabOf(projectId, tabId);
  if (tab === undefined) return Promise.resolve();
  const step = feed(tab.line, data);
  const store = useTerminalStore.getState();
  store.setLine(projectId, tabId, step.state);
  if (step.echo !== '') store.write(projectId, tabId, step.echo);
  let last: Promise<void> = Promise.resolve();
  for (const action of step.actions) {
    last = enqueue(projectId, tabId, () => perform(projectId, tabId, action, queryClient));
  }
  return last;
}

/** A script button (D301): the script runs in a new tab named after it, as `<pm> run <name>`. */
export function runScript(
  projectId: string,
  name: string,
  packageManager: PackageManager,
  queryClient: QueryClient,
): Promise<void> {
  const store = useTerminalStore.getState();
  const tabId = store.newTab(projectId, { label: name });
  store.write(projectId, tabId, `${packageManager} run ${name}\r\n`);
  const tab = tabOf(projectId, tabId);
  if (tab !== undefined) store.setLine(projectId, tabId, busyLine(tab.line));
  // No cwd: a script always runs at the project root (decision 5), whatever the tab's folder.
  return enqueue(projectId, tabId, () =>
    startInTab(projectId, tabId, { script: name }, queryClient),
  );
}

/**
 * A process no tab owns — started from another browser tab, or before a reload — opens in a new
 * tab with what the engine kept of its output, and takes typing from then on.
 */
export async function openProcessInTab(
  projectId: string,
  summary: ProcessSummary,
  queryClient: QueryClient,
): Promise<void> {
  const store = useTerminalStore.getState();
  const tabId = store.newTab(projectId, { label: summary.label, cwd: summary.cwd });
  // PG-5.3: an agent's command is shown, not driven — the engine refuses input and Stop for it.
  if (summary.agent !== undefined) {
    store.write(
      projectId,
      tabId,
      `\u001b[2m# An agent's command (read-only here; stop its run to stop it)\u001b[0m\r\n`,
    );
  }
  store.write(projectId, tabId, `${summary.command}\r\n`);
  const tab = tabOf(projectId, tabId);
  if (tab !== undefined) store.setLine(projectId, tabId, busyLine(tab.line));
  store.attach(projectId, tabId, summary.id);
  // Only this tab: the others keep what they show.
  await reattach(projectId, queryClient, summary.id);
}
