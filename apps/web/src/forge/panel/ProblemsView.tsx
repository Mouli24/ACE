import { Badge } from '@ace/ui';
import { useQueryClient } from '@tanstack/react-query';

import { api } from '../../app/api';
import { useLayoutStore } from '../../app/stores/layout';
import { useProject } from '../../projects/hooks';
import { fileIconColor } from '../../theme/constants';
import { ago } from '../../theme/format';
import { openFile } from '../editor/actions';
import { useEditorStore } from '../editor/editor-store';
import { nameOf, parentOf } from '../files/paths';
import { requestTerminalFocus } from '../terminal/focus';
import { openProcessInTab } from '../terminal/session';
import { TrustNotice } from '../terminal/TrustNotice';
import { FixWithAgentButton } from './FixWithAgentButton';
import {
  clearChecks,
  useProblemsStore,
  type ChecksRun,
  type Problem,
  type ProblemSeverity,
} from './problems-store';
import { checksBlocked } from './run-checks';

const NONE: Problem[] = [];

/** The severities as the Validation tab draws them (D328): ✕ in the error red, ! in the accent. */
const ICON: Record<ProblemSeverity, JSX.Element> = {
  error: (
    <span
      role="img"
      aria-label="Error"
      className="w-[12px] shrink-0 text-center text-[11px] text-[#c94c27]"
    >
      ✕
    </span>
  ),
  warning: (
    <span
      role="img"
      aria-label="Warning"
      className="w-[12px] shrink-0 text-center text-[12px] font-bold text-[#e8572e]"
    >
      !
    </span>
  ),
  info: (
    <span
      role="img"
      aria-label="Info"
      className="w-[12px] shrink-0 text-center text-[11px] font-bold text-[var(--muted)]"
    >
      i
    </span>
  ),
};

/** A problem from either slice: a marker, or a check's diagnostic with its code (`TS2322`, a rule). */
type ShownProblem = Problem & { code?: string };

/**
 * Problems by file, in the theme (D328) as the Validation tab: per file a header with the
 * extension dot, the name, the folder in mono and a count chip, then one surface card with a 36px
 * row per problem, hairlines between, the source (and code) and place in mono. A click opens the
 * file at the problem. Both the open files' markers and Run checks' results draw with this, so
 * D302's "Fix with agent", which hands the problem to the chat's current node, is on every row of
 * both.
 */
function ProblemGroups({
  projectId,
  problems,
  label,
}: {
  projectId: string;
  problems: readonly ShownProblem[];
  /** The lists' accessible names: "<label> in <path>". */
  label: string;
}) {
  const groups = new Map<string, ShownProblem[]>();
  for (const problem of problems)
    groups.set(problem.path, [...(groups.get(problem.path) ?? []), problem]);
  const reveal = (problem: Problem): void => {
    openFile(projectId, problem.path, { preview: false });
    useEditorStore
      .getState()
      .revealAt(projectId, { path: problem.path, line: problem.line, column: problem.column });
  };

  return (
    <>
      {[...groups].map(([path, list]) => (
        <section key={path} aria-label={path} className="flex flex-col gap-[6px]">
          <div className="flex min-w-0 items-center gap-[7px] text-[12.5px]">
            <span
              aria-hidden
              className="h-[8px] w-[8px] shrink-0 rounded-full"
              style={{ background: fileIconColor(path) }}
            />
            <span className="shrink-0 font-semibold text-[var(--ink)]">{nameOf(path)}</span>
            <span className="min-w-0 truncate font-machine text-[10px] text-[var(--muted)]">
              {parentOf(path)}
            </span>
            <Badge>{list.length}</Badge>
          </div>
          <ul
            aria-label={`${label} in ${path}`}
            className="m-0 flex list-none flex-col overflow-hidden rounded-[12px] border border-[var(--line)] bg-[var(--surface)] p-0"
          >
            {list.map((problem, index) => (
              <li
                key={`${problem.line}:${problem.column}:${index}`}
                className="flex items-center gap-[8px] border-t border-[var(--line)] pr-[10px] first:border-t-0 hover:bg-[var(--hover)]"
              >
                <button
                  type="button"
                  onClick={() => reveal(problem)}
                  className="flex min-h-[36px] min-w-0 flex-1 cursor-pointer items-center gap-[10px] border-none bg-transparent py-[7px] pl-[14px] pr-0 text-left text-[12.5px] text-[var(--ink)] outline-none focus-visible:shadow-[inset_0_0_0_2px_#ef6b3f]"
                >
                  {ICON[problem.severity]}
                  <span className="min-w-0 flex-1 whitespace-pre-wrap">{problem.message}</span>
                  <span className="shrink-0 font-machine text-[9.5px] text-[var(--muted)]">
                    {problem.source === undefined
                      ? ''
                      : `${problem.source}${problem.code === undefined ? '' : `(${problem.code})`} `}
                    [Ln {problem.line}, Col {problem.column}]
                  </span>
                </button>
                <FixWithAgentButton projectId={projectId} problem={problem} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

/** "2m ago · 3.4 s · exit 0", or "running…" while the run is on (fix I2: the exit code always). */
function runTime(run: ChecksRun): string {
  if (run.status === 'running') return 'running…';
  const finished = run.finishedAt ?? run.startedAt;
  const seconds = Math.max(
    0,
    (new Date(finished).getTime() - new Date(run.startedAt).getTime()) / 1000,
  );
  const exit = run.exitCode === undefined ? '' : ` · exit ${run.exitCode ?? 'none'}`;
  return `${ago(finished)} · ${seconds.toFixed(1)} s${exit}`;
}

/**
 * A run that exited non-zero with nothing the parser recognised (fix I2): a crash, a command not
 * found, a format it does not read. Never "No problems found" — that would be a false all-clear.
 */
const failedSilently = (run: ChecksRun): boolean =>
  run.status === 'done' &&
  run.problems.length === 0 &&
  run.exitCode !== undefined &&
  run.exitCode !== 0;

/**
 * Run checks' results (D299 Phase 4): the "Checks" group under the open files' problems, with the
 * tools that reported (`tsc`, `eslint`, `check`), when it ran and how long it took, and Clear.
 */
function ChecksGroup({ projectId, run }: { projectId: string; run: ChecksRun }) {
  const queryClient = useQueryClient();
  const sources = [...new Set(run.problems.map((problem) => problem.source))];
  /** The Checks process's output, in a Terminal tab of its own. */
  const showOutput = async (processId: string): Promise<void> => {
    useLayoutStore.getState().showPanel('terminal');
    requestTerminalFocus();
    await openProcessInTab(projectId, await api().getProcess(projectId, processId), queryClient);
  };
  return (
    <section aria-label="Checks" data-testid="checks-group" className="flex flex-col gap-[8px]">
      <div className="flex min-w-0 items-center gap-[8px] border-t border-[var(--line)] pt-[10px]">
        <span className="shrink-0 text-[12.5px] font-bold text-[var(--ink)]">Checks</span>
        {sources.length > 0 && (
          <span
            data-testid="checks-sources"
            className="shrink-0 font-machine text-[10px] text-[var(--muted)]"
          >
            {sources.join(' · ')}
          </span>
        )}
        <span
          data-testid="checks-time"
          title={run.command}
          className="min-w-0 truncate font-machine text-[10px] text-[var(--muted)]"
        >
          {runTime(run)}
        </span>
        <div className="flex-1" />
        <button
          type="button"
          title="Clear checks"
          onClick={() => clearChecks(projectId)}
          disabled={run.status === 'running'}
          className="flex h-[20px] shrink-0 cursor-pointer items-center rounded-[5px] border-none bg-transparent px-[6px] text-[11px] text-[var(--muted)] outline-none hover:bg-[var(--hover)] hover:text-[var(--ink)] focus-visible:shadow-[inset_0_0_0_2px_#ef6b3f] disabled:cursor-default disabled:opacity-[0.45]"
        >
          Clear
        </button>
      </div>
      {run.error !== undefined && (
        <p role="alert" className="m-0 text-[11px] leading-[1.45] text-[#c94c27]">
          {run.error}
        </p>
      )}
      {failedSilently(run) && (
        <div role="alert" className="flex min-w-0 items-center gap-[8px]">
          <p className="m-0 min-w-0 flex-1 text-[12px] leading-[1.45] text-[#c94c27]">
            Checks failed (exit {run.exitCode}); no problems recognised in the output
          </p>
          {run.processId !== undefined && (
            <button
              type="button"
              onClick={() => run.processId !== undefined && void showOutput(run.processId)}
              className="flex h-[20px] shrink-0 cursor-pointer items-center rounded-[5px] border-none bg-transparent px-[6px] text-[11px] font-semibold text-[var(--ink)] outline-none hover:bg-[var(--hover)] focus-visible:shadow-[inset_0_0_0_2px_#ef6b3f]"
            >
              Show output
            </button>
          )}
        </div>
      )}
      {run.status === 'done' && run.problems.length === 0 && !failedSilently(run) && (
        // no period after the command: one ending in `.` (`tsc -p .`) would read `..` (smoke S-1)
        <p className="m-0 text-[12px] text-[var(--muted)]">
          No problems found by <span className="font-machine">{run.command}</span>
        </p>
      )}
      <ProblemGroups projectId={projectId} problems={run.problems} label="Checks" />
    </section>
  );
}

/**
 * Problems (design §6.4): Monaco's markers for the open files, by file, errors first; then Run
 * checks' results in their own group (D299 Phase 4). With the terminal off, the trust notice says
 * why Run checks cannot run.
 */
export function ProblemsView({ projectId }: { projectId: string }) {
  const problems = useProblemsStore((s) => s.byProject[projectId] ?? NONE);
  const checks = useProblemsStore((s) => s.checks[projectId]);
  const project = useProject(projectId);
  const off = checksBlocked(project.data) === 'terminal_off';

  return (
    <div className="flex flex-col gap-3 py-3">
      {off && <TrustNotice projectId={projectId} trust="off" />}
      {problems.length === 0 ? (
        <p className="m-0 text-[12px] text-[var(--muted)]">No problems in the open files.</p>
      ) : (
        <ProblemGroups projectId={projectId} problems={problems} label="Problems" />
      )}
      {checks !== undefined && <ChecksGroup projectId={projectId} run={checks} />}
    </div>
  );
}
