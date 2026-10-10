import { AlertTriangle, GitBranch, PanelBottom, XCircle } from 'lucide-react';

import { SHORTCUTS, shortcutLabel } from '../../app/shortcuts';
import { useLayoutStore } from '../../app/stores/layout';
import { useProjectEditor } from '../editor/editor-store';
import { useEditorStatus } from '../editor/editor-status';
import { languageLabel } from '../editor/languages';
import { useRepoStatus } from '../files/hooks';
import { isImagePath } from '../files/paths';
import { useProblemsStore, type Problem } from '../panel/problems-store';

const NONE: Problem[] = [];
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** VS Code's status bar (design §2.2): branch and problems on the left, the active file's facts on the right. */
export function StatusBar({ projectId }: { projectId: string }) {
  const status = useRepoStatus(projectId);
  const problems = useProblemsStore((s) => s.byProject[projectId] ?? NONE);
  const showPanel = useLayoutStore((s) => s.showPanel);
  const panelOpen = useLayoutStore((s) => s.panelOpen);
  const togglePanel = useLayoutStore((s) => s.togglePanel);
  const active = useProjectEditor(projectId).active;
  const editor = useEditorStatus();
  const branch = status.data?.repo === true ? status.data.branch : undefined;
  const errors = problems.filter((p) => p.severity === 'error').length;
  const warnings = problems.filter((p) => p.severity === 'warning').length;
  const textActive = active !== undefined && !isImagePath(active);

  return (
    <footer
      data-testid="status-bar"
      className="flex h-6 shrink-0 items-center gap-3 border-t border-border bg-panel px-3 font-machine text-[11px] text-fg-muted"
    >
      {branch && (
        <span className="flex items-center gap-1" title="Current branch (read-only)">
          <GitBranch className="h-3 w-3" aria-hidden />
          {branch}
        </span>
      )}
      <button
        type="button"
        aria-label={`${plural(errors, 'error')}, ${plural(warnings, 'warning')}`}
        title="Problems"
        onClick={() => showPanel('problems')}
        className="flex items-center gap-2 hover:text-fg"
      >
        <span className="flex items-center gap-1">
          <XCircle className="h-3 w-3" aria-hidden />
          {errors}
        </span>
        <span className="flex items-center gap-1">
          <AlertTriangle className="h-3 w-3" aria-hidden />
          {warnings}
        </span>
      </button>
      <div className="flex-1" />
      {textActive && (
        <>
          <span>{`Ln ${editor.line}, Col ${editor.column}`}</span>
          <span>{editor.indentation}</span>
          <span>{editor.bom ? 'UTF-8 with BOM' : 'UTF-8'}</span>
          <span>{editor.eol}</span>
          <span>{languageLabel(editor.language)}</span>
        </>
      )}
      <button
        type="button"
        aria-pressed={panelOpen}
        onClick={togglePanel}
        title={`Toggle panel (${shortcutLabel(SHORTCUTS.togglePanel)})`}
        className="flex items-center gap-1 hover:text-fg"
      >
        <PanelBottom className="h-3 w-3" aria-hidden />
        Panel
      </button>
    </footer>
  );
}
