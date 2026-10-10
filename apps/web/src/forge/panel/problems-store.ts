import type * as Monaco from 'monaco-editor';
import { create } from 'zustand';

import { pathOfUri } from '../editor/models';

export type ProblemSeverity = 'error' | 'warning' | 'info';

export interface Problem {
  path: string;
  line: number;
  column: number;
  severity: ProblemSeverity;
  message: string;
  source: string | undefined;
}

export const useProblemsStore = create<{ byProject: Record<string, Problem[]> }>()(() => ({
  byProject: {},
}));

const RANK: Record<ProblemSeverity, number> = { error: 0, warning: 1, info: 2 };

/**
 * Follow Monaco's markers for every Forge model (Problems, design §6.4): grouped by project, errors
 * first, hints left out as VS Code does. A disposed model's markers go with it. Phase 4 adds the
 * project's check command to the same list.
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
