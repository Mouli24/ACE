import { useQueryClient } from '@tanstack/react-query';

import { SHORTCUTS, useShortcuts } from '../app/shortcuts';
import { useLayoutStore } from '../app/stores/layout';
import { useForgeAttribution } from './attribution';
import { saveAll, saveFile } from './editor/actions';
import { useCloseRequest } from './editor/CloseDialogs';
import { EditorArea } from './editor/EditorArea';
import { useEditorStore } from './editor/editor-store';
import { useEditorSync } from './editor/useEditorSync';
import { ExplorerView } from './explorer/ExplorerView';
import { useSideViewStore } from './explorer/side-view-store';
import { BottomPanel } from './panel/BottomPanel';
import { runChecks } from './panel/run-checks';
import { QuickOpen } from './quick-open/QuickOpen';
import { useQuickOpen } from './quick-open/quick-open-store';
import { toggleTerminalFocused } from './terminal/focus';

/**
 * Forge in the Ace UI theme's code view (D334, after D299): a fixed 248px Explorer beside the code
 * column (tabs, path bar, editor), and under the code column the bottom panel with the Terminal and
 * Problems while the person has it open (Ctrl/⌘+J, Ctrl+` for the Terminal, or the footer's counts;
 * maximizable). Ctrl/⌘+B hides the Explorer, Ctrl/⌘+P opens any file; saving, Save all and closing
 * a tab keep their keys. The chat aside and the footer are the workspace layout's, not Forge's.
 */
export function ForgeWorkbench({
  projectId,
  workflowId,
}: {
  projectId: string;
  /** The workflow whose run Forge shows and starts. */
  workflowId?: string;
}) {
  const explorerOpen = useLayoutStore((s) => s.sidebarOpen);
  const toggleExplorer = useLayoutStore((s) => s.toggleSidebar);
  const panelOpen = useLayoutStore((s) => s.panelOpen);
  const maximized = useLayoutStore((s) => s.panelMaximized);
  const togglePanel = useLayoutStore((s) => s.togglePanel);
  const queryClient = useQueryClient();
  const closeRequest = useCloseRequest(projectId);
  const attribution = useForgeAttribution(projectId, workflowId);
  useEditorSync(projectId);
  const activePath = (): string | undefined =>
    useEditorStore.getState().projects[projectId]?.active;
  useShortcuts([
    [SHORTCUTS.toggleSidebar, toggleExplorer],
    [SHORTCUTS.togglePanel, togglePanel],
    [SHORTCUTS.toggleTerminal, toggleTerminalFocused],
    [SHORTCUTS.quickOpen, () => useQuickOpen.getState().show()],
    [
      SHORTCUTS.searchFiles,
      () => {
        if (!useLayoutStore.getState().sidebarOpen) toggleExplorer();
        useSideViewStore.getState().focusSearch();
      },
    ],
    [
      SHORTCUTS.save,
      () => {
        const active = activePath();
        if (active !== undefined) void saveFile(projectId, active, queryClient);
      },
    ],
    [SHORTCUTS.saveAll, () => void saveAll(projectId, queryClient)],
    [
      SHORTCUTS.runChecks,
      () => {
        // Problems shows the run, or why it cannot run (no command, the terminal off).
        useLayoutStore.getState().showPanel('problems');
        void runChecks(projectId, queryClient);
      },
    ],
    [
      SHORTCUTS.closeTab,
      () => {
        const active = activePath();
        if (active !== undefined) closeRequest.request([active]);
      },
    ],
  ]);
  const showEditor = !(panelOpen && maximized);

  return (
    <div data-testid="forge" className="flex h-full min-h-0 min-w-0 flex-1">
      {explorerOpen && <ExplorerView projectId={projectId} live={attribution.live} />}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {showEditor && (
          <EditorArea projectId={projectId} workflowId={workflowId} attribution={attribution} />
        )}
        {panelOpen && <BottomPanel projectId={projectId} />}
      </div>
      {closeRequest.dialog}
      <QuickOpen projectId={projectId} />
    </div>
  );
}
