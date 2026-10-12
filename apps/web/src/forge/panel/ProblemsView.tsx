import { fileIconColor } from '../../theme/constants';
import { openFile } from '../editor/actions';
import { useEditorStore } from '../editor/editor-store';
import { nameOf, parentOf } from '../files/paths';
import { useProblemsStore, type Problem, type ProblemSeverity } from './problems-store';

const NONE: Problem[] = [];
const ICON: Record<ProblemSeverity, JSX.Element> = {
  error: (
    <span role="img" aria-label="Error" className="mt-0.5 w-3.5 shrink-0 text-center text-danger">
      ✕
    </span>
  ),
  warning: (
    <span
      role="img"
      aria-label="Warning"
      className="mt-0.5 w-3.5 shrink-0 text-center text-[var(--color-status-WAITING)]"
    >
      !
    </span>
  ),
  info: (
    <span role="img" aria-label="Info" className="mt-0.5 w-3.5 shrink-0 text-center text-fg-muted">
      i
    </span>
  ),
};

export function ProblemsView({ projectId }: { projectId: string }) {
  const problems = useProblemsStore((s) => s.byProject[projectId] ?? NONE);
  if (problems.length === 0)
    return <p className="px-3 py-2 text-[12px] text-fg-muted">No problems in the open files.</p>;

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
    <div className="h-full overflow-auto py-1 font-machine text-[12px]">
      {[...groups].map(([path, list]) => (
        <section key={path} aria-label={path}>
          <div className="flex items-center gap-1.5 px-3 py-0.5 text-fg-soft">
            <span aria-hidden className="h-[7px] w-[7px] shrink-0 rounded-full" style={{ background: fileIconColor(path) }} />
            <span>{nameOf(path)}</span>
            <span className="text-fg-faint">{parentOf(path)}</span>
            <span className="ml-1 rounded-chip bg-card px-1.5 text-[10px]">{list.length}</span>
          </div>
          <ul aria-label={`Problems in ${path}`}>
            {list.map((problem, index) => (
              <li key={`${problem.line}:${problem.column}:${index}`}>
                <button
                  type="button"
                  onClick={() => reveal(problem)}
                  className="flex w-full items-start gap-2 py-0.5 pl-8 pr-3 text-left hover:bg-card"
                >
                  {ICON[problem.severity]}
                  <span className="min-w-0 flex-1 whitespace-pre-wrap text-fg">
                    {problem.message}
                  </span>
                  <span className="shrink-0 text-fg-faint">
                    {problem.source === undefined ? '' : `${problem.source} `}[Ln {problem.line},
                    Col {problem.column}]
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
