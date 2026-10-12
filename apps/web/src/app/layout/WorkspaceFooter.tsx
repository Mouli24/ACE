import { slugHandle } from '@ace/contracts';
import { useShallow } from 'zustand/react/shallow';

import { CursorInfo, ProblemsCount } from '../../forge/layout/StatusBar';
import type { WorkflowMode } from '../../forge/mode';
import { useProject } from '../../projects/hooks';
import { useSocketStatus } from '../../runs/hooks';
import { useRunStore } from '../../runs/run-store';
import { SocketNotice } from '../../runs/SocketNotice';
import { fmt } from '../../theme/constants';
import { useWorkspaceStatus, type WorkspaceTokens } from '../stores/workspace-status';
import { SettingsMenu } from './SettingsMenu';

const MODE_LABEL: Readonly<Record<WorkflowMode, string>> = {
  ideate: 'Ideate',
  forge: 'Forge',
  domain: 'Domain',
};

/**
 * The workspace footer of `Ace Canvas.dc.html` (D330), every value real: the settings gear (D338),
 * the engine connection (FR-EXE-014) and the project slug; in Forge the problem counts and the
 * cursor, file facts, language and unsaved state (Forge's status bar, D299); the mode; the open
 * conversation's message count; the tokens in view, "—" without data.
 */
export function WorkspaceFooter({
  projectId,
  workflowId,
  mode,
}: {
  projectId: string;
  workflowId: string;
  mode: WorkflowMode;
}) {
  const project = useProject(projectId);
  const messageCount = useWorkspaceStatus((store) => store.messageCount);
  const tokens = useFooterTokens(workflowId, mode);
  // not drawn: the run's state for tests and tools, now that the header has no run chip (D330)
  const runStatus = useRunStore((store) =>
    store.workflowId === workflowId ? store.status : undefined,
  );
  return (
    <footer
      data-run-status={runStatus}
      className="grid h-6 shrink-0 grid-cols-[1fr_auto_1fr] items-center border-t border-[var(--line)] bg-[var(--hdr)] px-[14px] text-[10px] text-[var(--muted)]"
    >
      <div className="flex min-w-0 items-center gap-[6px]">
        <SettingsMenu placement="footer" />
        <Connection />
        {project.data && (
          <>
            <span aria-hidden className="opacity-50">
              |
            </span>
            <span data-testid="project-slug" title={project.data.name} className="font-machine">
              {slugHandle(project.data.name)}
            </span>
          </>
        )}
        {mode === 'forge' && (
          <>
            <span aria-hidden className="opacity-50">
              |
            </span>
            <ProblemsCount projectId={projectId} />
          </>
        )}
      </div>
      <div aria-hidden className="h-1 w-7 rounded-[2px] bg-[var(--iconLine)]" />
      <div className="flex min-w-0 justify-end gap-[14px] overflow-hidden whitespace-nowrap font-machine text-[9.5px]">
        {mode === 'forge' && <CursorInfo projectId={projectId} />}
        <span data-testid="footer-mode">{MODE_LABEL[mode]}</span>
        {messageCount !== null && (
          <span data-testid="footer-messages">{messageCount} messages</span>
        )}
        <span data-testid="footer-tokens">
          {tokens ? `${fmt(tokens.in)} in / ${fmt(tokens.out)} out` : '— in / — out'}
        </span>
      </div>
    </footer>
  );
}

/**
 * The live socket: open is Connected; connecting or reconnecting says so; a 4403 (D301) says this
 * page's address may not connect, as an alert, since no retry fixes it; anything else is down.
 */
function Connection() {
  const status = useSocketStatus();
  if (status === 'forbidden_origin') return <SocketNotice status={status} />;
  const reconnecting = status === 'connecting' || status === 'reconnecting';
  const look =
    status === 'open'
      ? { color: '#2f9e63', label: 'Connected' }
      : reconnecting
        ? { color: '#a39d97', label: 'Reconnecting…' }
        : { color: '#c94c27', label: 'Disconnected' };
  return (
    <span
      role="status"
      data-testid={reconnecting ? 'socket-reconnecting' : 'socket-status'}
      data-status={status}
      className="flex items-center gap-[6px]"
    >
      <span
        aria-hidden
        className="h-[6px] w-[6px] shrink-0 rounded-full"
        style={{ background: look.color }}
      />
      {look.label}
    </span>
  );
}

/**
 * Domain's tokens are what the Domain page publishes (its usage totals); Ideate and Forge show
 * this workflow's run totals from the live overlay, as the run bar did.
 */
function useFooterTokens(workflowId: string, mode: WorkflowMode): WorkspaceTokens | null {
  const published = useWorkspaceStatus((store) => store.tokens);
  const run = useRunStore(
    useShallow((store) =>
      store.workflowId === workflowId && store.totals
        ? { in: store.totals.tokensIn, out: store.totals.tokensOut }
        : null,
    ),
  );
  return mode === 'domain' ? published : run;
}
