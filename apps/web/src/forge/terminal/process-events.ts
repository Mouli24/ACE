import { AceApiError } from '@ace/sdk';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { api } from '../../app/api';
import { getSocket } from '../../app/socket';
import { useProjectScope } from '../project-scope';
import { processKeys } from './hooks';
import { DROPPED_NOTE, ownerOf, useTerminalStore } from './terminal-store';

/** A change to one of these, in the project root, can change the scripts or their manager. */
const SCRIPT_FILES = /^(package\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|package-lock\.json)$/;

/**
 * Re-attach every tab that runs a process (D301 decision 8). Process frames are transient, so
 * output printed while nobody watched — in Ideate, or with the socket down — is never replayed;
 * the engine's kept copy replaces what the tab holds for the process instead, so it shows once and
 * never doubles. A process that ended meanwhile ends the tab's run; one the engine no longer knows
 * (it restarted) says so and gives the prompt back.
 * A process that no tab owns any more by the time its detail arrives is left alone.
 *
 * Accepted edge: a batch the engine emits after taking its copy, but which arrives before the HTTP
 * answer, is replaced away at the seam. At worst one 50 ms batch is lost on a reconnect; nothing
 * is ever shown twice.
 */
export async function reattach(
  projectId: string,
  queryClient: QueryClient,
  /** Just this process's tab: a tab opened from the Processes list leaves the others alone. */
  only?: string,
): Promise<void> {
  void queryClient.invalidateQueries({ queryKey: processKeys.list(projectId) });
  const tabs = useTerminalStore.getState().projects[projectId]?.tabs ?? [];
  const attached = tabs.flatMap((tab) =>
    tab.processId === undefined || (only !== undefined && tab.processId !== only)
      ? []
      : [tab.processId],
  );
  await Promise.all(
    attached.map(async (processId) => {
      const store = useTerminalStore.getState();
      try {
        const detail = await api().getProcess(projectId, processId);
        // Another re-attach (on mount and on hello, overlapping) may have ended this run already;
        // touching it again would leave a stale unowned entry.
        if (ownerOf(projectId, processId) === undefined) return;
        store.replaceLive(
          projectId,
          processId,
          (detail.truncated ? DROPPED_NOTE : '') + detail.output,
        );
        if (detail.status !== 'running') {
          store.exited(projectId, processId, {
            exitCode: detail.exitCode,
            signal: detail.signal,
            status: detail.status,
          });
        }
      } catch (error) {
        if (AceApiError.is(error) && error.status === 404) store.lost(projectId, processId);
      }
    }),
  );
}

/**
 * While Forge is open (D301): hold the project's scope, fold each process frame into the tab that
 * owns the process (or keep it for the Processes list), and re-attach on entering and on every
 * reconnect (`hello`).
 */
export function useProcessEvents(projectId: string): void {
  const queryClient = useQueryClient();
  useProjectScope(projectId);
  useEffect(() => {
    if (projectId === '') return;
    void reattach(projectId, queryClient);
    const socket = getSocket();
    if (!socket) return;
    const offs = [
      socket.on('process.output', (payload) => {
        if (payload.projectId !== projectId) return;
        const before = useTerminalStore.getState();
        const known =
          before.projects[projectId]?.tabs.some((tab) => tab.processId === payload.processId) ===
            true || before.unowned[payload.processId] !== undefined;
        before.output(projectId, payload.processId, payload.data);
        // A process this window did not start (another browser tab, or before a reload).
        if (!known) void queryClient.invalidateQueries({ queryKey: processKeys.list(projectId) });
      }),
      socket.on('process.exited', (payload) => {
        if (payload.projectId !== projectId) return;
        useTerminalStore.getState().exited(projectId, payload.processId, {
          exitCode: payload.exitCode,
          signal: payload.signal,
          status: payload.status,
        });
        void queryClient.invalidateQueries({ queryKey: processKeys.list(projectId) });
      }),
      socket.on('files.changed', (payload) => {
        if (payload.projectId !== projectId) return;
        if (payload.resync || payload.changes.some((change) => SCRIPT_FILES.test(change.path))) {
          void queryClient.invalidateQueries({ queryKey: processKeys.scripts(projectId) });
        }
      }),
      socket.on('hello', () => void reattach(projectId, queryClient)),
    ];
    return () => offs.forEach((off) => off());
  }, [projectId, queryClient]);
}
