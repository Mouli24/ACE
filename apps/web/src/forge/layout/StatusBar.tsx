import { GitBranch, PanelBottom } from 'lucide-react';

import { SHORTCUTS, shortcutLabel } from '../../app/shortcuts';
import { useLayoutStore } from '../../app/stores/layout';
import { useRepoStatus } from '../files/hooks';

/** VS Code's status bar (design §2.2). Task 18 adds the problem counts and the editor's fields. */
export function StatusBar({ projectId }: { projectId: string }) {
  const status = useRepoStatus(projectId);
  const panelOpen = useLayoutStore((s) => s.panelOpen);
  const togglePanel = useLayoutStore((s) => s.togglePanel);
  const branch = status.data?.repo === true ? status.data.branch : undefined;
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
      <div className="flex-1" />
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
