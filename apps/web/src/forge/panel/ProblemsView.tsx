import { Badge } from '@ace/ui';

import { fileIconColor } from '../../theme/constants';
import { openFile } from '../editor/actions';
import { useEditorStore } from '../editor/editor-store';
import { nameOf, parentOf } from '../files/paths';
import { FixWithAgentButton } from './FixWithAgentButton';
import { useProblemsStore, type Problem, type ProblemSeverity } from './problems-store';

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

/**
 * Problems (design §6.4): Monaco's markers for the open files, by file, errors first; a click
 * opens the file at the problem. In the theme (D328), as the Validation tab: per file a header
 * with the extension dot, the name, the folder in mono and a count chip, then one surface card with
 * a 36px row per problem, hairlines between, the source and place in mono. D302: each row has
 * "Fix with agent", which hands the problem to the chat's current node.
 */
export function ProblemsView({ projectId }: { projectId: string }) {
  const problems = useProblemsStore((s) => s.byProject[projectId] ?? NONE);
  if (problems.length === 0)
    return <p className="py-3 text-[12px] text-[var(--muted)]">No problems in the open files.</p>;

  const groups = new Map<string, Problem[]>();
  for (const problem of problems)
    groups.set(problem.path, [...(groups.get(problem.path) ?? []), problem]);
  const reveal = (problem: Problem): void => {
    openFile(projectId, problem.path, { preview: false });
    useEditorStore
      .getState()
      .revealAt(projectId, { path: problem.path, line: problem.line, column: problem.column });
  };

  return (
    <div className="flex flex-col gap-3 py-3">
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
            aria-label={`Problems in ${path}`}
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
                    {problem.source === undefined ? '' : `${problem.source} `}[Ln {problem.line},
                    Col {problem.column}]
                  </span>
                </button>
                <FixWithAgentButton projectId={projectId} problem={problem} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
