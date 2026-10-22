import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useInRouterContext } from 'react-router-dom';

import { SHORTCUTS, useShortcuts } from '../app/shortcuts';
import { useLayoutStore } from '../app/stores/layout';
import { WorkflowUndoChoice } from '../runs/UndoChoice';
import { askAgentAboutFile, askAgentAboutSelection, setBufferSaver } from './ask-agent';
import { useForgeAttribution } from './attribution';
import { saveAll, saveFile } from './editor/actions';
import { useCloseRequest } from './editor/CloseDialogs';
import { useCloseTabKey } from './editor/close-tab-key';
import { EditorArea } from './editor/EditorArea';
import { useEditorStore } from './editor/editor-store';
import { useEditorSync } from './editor/useEditorSync';
import { ExplorerView } from './explorer/ExplorerView';
import { FollowedNodeBar, useFollowedFiles } from './FollowedNode';
import { useSideViewStore } from './explorer/side-view-store';
import { BottomPanel } from './panel/BottomPanel';
import { runChecks, stopFollowingChecks } from './panel/run-checks';
import { QuickOpen } from './quick-open/QuickOpen';
import { useQuickOpen } from './quick-open/quick-open-store';
import { toggleTerminalFocused } from './terminal/focus';

/**
 * Forge in the Ace UI theme's code view (D334, after D299): a 248px Explorer beside the code
 * column (tabs, path bar, editor), and under the code column the bottom panel with the Terminal and
 * Problems while the person has it open (Ctrl/⌘+J, Ctrl+` for the Terminal, or the footer's counts;
 * maximizable); both resize from their edge ([audit F-7]). Ctrl/⌘+B hides the Explorer, Ctrl/⌘+P opens any file; saving, Save all and closing
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
  // PG-3.4: a node followed here — its files marked in the Explorer, its bar over the editor
  const followed = useFollowedFiles(workflowId, attribution);
  const routed = useInRouterContext();
  useEditorSync(projectId);
  // D299 Phase 4's cross-file types load in the workflow layout, kept across modes ([audit F-6]).
  // Leaving the project stops following its Run checks (fix Minor 6).
  useEffect(() => () => stopFollowingChecks(projectId), [projectId]);
  // [audit F-1] Ask agent saves an unsaved buffer before the agent hears of it, through Save.
  useEffect(
    () => setBufferSaver((owner, path) => saveFile(owner, path, queryClient)),
    [queryClient],
  );
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
      // D302: the editor's selection, or — with no editor to ask — the active file.
      SHORTCUTS.askAgent,
      () => {
        if (askAgentAboutSelection(projectId)) return;
        const active = activePath();
        if (active !== undefined) askAgentAboutFile(active, projectId);
      },
    ],
    [
      SHORTCUTS.runChecks,
      () => {
        // Problems shows the run, or why it cannot run (no command, the terminal off).
        useLayoutStore.getState().showPanel('problems');
        void runChecks(projectId, queryClient);
      },
    ],
  ]);
  // Alt+W, unless the focused field means something else by it ([audit F-10]).
  useCloseTabKey(() => {
    const active = activePath();
    if (active !== undefined) closeRequest.request([active]);
  });
  const showEditor = !(panelOpen && maximized);

  return (
    <div data-testid="forge" className="flex h-full min-h-0 min-w-0 flex-1">
      {explorerOpen && (
        <ExplorerView
          projectId={projectId}
          workflowId={workflowId}
          live={attribution.live}
          followed={followed}
        />
      )}
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        {/* PG-2.4 (D361): a writing run stopped without undo asks here too. */}
        {workflowId !== undefined && <WorkflowUndoChoice workflowId={workflowId} />}
        {routed && workflowId !== undefined && followed !== undefined && (
          <FollowedNodeBar workflowId={workflowId} followed={followed} />
        )}
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
