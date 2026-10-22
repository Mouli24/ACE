import { Icons } from '@ace/ui';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useInRouterContext } from 'react-router-dom';

import { shortcutLabel, SHORTCUTS } from '../../app/shortcuts';
import { useProject } from '../../projects/hooks';
import { useProblemsStore } from './problems-store';
import { checksBlocked, runChecks } from './run-checks';

/** The path bar's "▶ Run pipeline" pill (D334), for the Problems header's own action. */
const PILL =
  'flex h-[24px] shrink-0 cursor-pointer items-center gap-[6px] whitespace-nowrap rounded-[999px] border border-[var(--line)] bg-[var(--chip)] px-[10px] font-human text-[11px] font-semibold text-[var(--ink)] no-underline outline-none hover:bg-[var(--hover)] hover:text-[var(--ink)] focus-visible:border-[var(--focus)] disabled:cursor-default disabled:opacity-[0.45] disabled:hover:bg-[var(--chip)]';

/**
 * Run checks in the Problems header (D299 Phase 4, design §6.4): runs the project's check command
 * (Ctrl/⌘+Shift+B does the same). With no command set it reads "Set a check command" and goes to
 * the project page; with the terminal off it is disabled, and Problems shows the trust notice.
 */
export function RunChecksButton({ projectId }: { projectId: string }) {
  const project = useProject(projectId);
  const queryClient = useQueryClient();
  const running = useProblemsStore((state) => state.checks[projectId]?.status === 'running');
  const blocked = checksBlocked(project.data);
  // The panel also renders outside the app's router (in its own tests); a plain link serves there.
  const routed = useInRouterContext();

  if (blocked === 'no_command') {
    const link = {
      'data-testid': 'set-check-command',
      title: 'Name the command Run checks runs, on the project page',
      className: PILL,
      children: 'Set a check command',
    };
    return routed ? (
      <Link to={`/projects/${projectId}`} {...link} />
    ) : (
      <a href={`/projects/${projectId}`} {...link} />
    );
  }
  const off = blocked === 'terminal_off';
  return (
    <button
      type="button"
      data-testid="run-checks"
      onClick={() => void runChecks(projectId, queryClient)}
      disabled={blocked !== undefined || running}
      title={
        off
          ? 'The terminal is off for this project'
          : `Run ${project.data?.checkCommand ?? 'the check command'} (${shortcutLabel(SHORTCUTS.runChecks)})`
      }
      className={PILL}
    >
      <span aria-hidden className="text-[9px] text-[#2f9e63]">
        <Icons.Play aria-hidden size={12} />
      </span>
      {running ? 'Running checks…' : 'Run checks'}
    </button>
  );
}
