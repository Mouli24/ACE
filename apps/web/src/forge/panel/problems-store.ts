import type * as Monaco from 'monaco-editor';
import { create } from 'zustand';

import { pathOfUri } from '../editor/models';
import type { CheckProblem } from './check-parser';

export type ProblemSeverity = 'error' | 'warning' | 'info';

export interface Problem {
  path: string;
  line: number;
  column: number;
  severity: ProblemSeverity;
  message: string;
  source: string | undefined;
}

/**
 * One Run checks (D299 Phase 4, design §6.4): the project's check command run as a process, and
 * what its output said. `running` keeps the last run's problems on show until the new ones land.
 */
export interface ChecksRun {
  status: 'running' | 'done' | 'failed';
  command: string;
  /** The process in the Terminal's list; absent when it never started. */
  processId?: string;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number | null;
  problems: CheckProblem[];
  /** Why it could not run: the engine's refusal, or what went wrong. */
  error?: string;
}

export interface ProblemsState {
  /** Monaco's markers for the open files, replaced whole by every marker change. */
  byProject: Record<string, Problem[]>;
  /** Run checks' last run per project: a separate slice, so the markers never overwrite it. */
  checks: Record<string, ChecksRun>;
}

export const useProblemsStore = create<ProblemsState>()(() => ({
  byProject: {},
  checks: {},
}));

/** A new run replaces the project's checks slice, whole. */
export function setChecks(projectId: string, run: ChecksRun): void {
  useProblemsStore.setState((state) => ({ checks: { ...state.checks, [projectId]: run } }));
}

/** Problems' Clear: the project's checks are gone until the next run. */
export function clearChecks(projectId: string): void {
  useProblemsStore.setState((state) => {
    const { [projectId]: _cleared, ...rest } = state.checks;
    return { checks: rest };
  });
}

/** The footer's and the panel's counts: the open files' markers and the checks, together. */
export function problemCounts(
  state: ProblemsState,
  projectId: string,
): { errors: number; warnings: number; total: number } {
  const all = [...(state.byProject[projectId] ?? []), ...(state.checks[projectId]?.problems ?? [])];
  return {
    errors: all.filter((problem) => problem.severity === 'error').length,
    warnings: all.filter((problem) => problem.severity === 'warning').length,
    total: all.length,
  };
}

const RANK: Record<ProblemSeverity, number> = { error: 0, warning: 1, info: 2 };

/**
 * Follow Monaco's markers for every Forge model (Problems, design §6.4): grouped by project, errors
 * first, hints left out as VS Code does. A disposed model's markers go with it. Run checks' results
 * live in their own `checks` slice, which this never touches.
 */
export function watchMarkers(monaco: typeof Monaco): () => void {
  const publish = (): void => {
    const byProject: Record<string, Problem[]> = {};
    for (const marker of monaco.editor.getModelMarkers({})) {
      const where = pathOfUri(marker.resource);
      if (where === undefined || marker.severity < monaco.MarkerSeverity.Info) continue;
      const severity: ProblemSeverity =
        marker.severity >= monaco.MarkerSeverity.Error
          ? 'error'
          : marker.severity >= monaco.MarkerSeverity.Warning
            ? 'warning'
            : 'info';
      (byProject[where.projectId] ??= []).push({
        path: where.path,
        line: marker.startLineNumber,
        column: marker.startColumn,
        severity,
        message: marker.message,
        source: marker.source,
      });
    }
    for (const problems of Object.values(byProject)) {
      problems.sort(
        (a, b) =>
          a.path.localeCompare(b.path) || RANK[a.severity] - RANK[b.severity] || a.line - b.line,
      );
    }
    useProblemsStore.setState({ byProject });
  };
  publish();
  const subscription = monaco.editor.onDidChangeMarkers(publish);
  return () => subscription.dispose();
}
