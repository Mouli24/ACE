import { useQueryClient } from '@tanstack/react-query';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';

import { RESIZE_HANDLE_X, RESIZE_HANDLE_Y } from '../app/layout/resize-handle';
import { SHORTCUTS, useShortcuts } from '../app/shortcuts';
import { useLayoutStore } from '../app/stores/layout';
import { saveAll, saveFile } from './editor/actions';
import { useCloseRequest } from './editor/CloseDialogs';
import { EditorArea } from './editor/EditorArea';
import { useEditorStore } from './editor/editor-store';
import { useEditorSync } from './editor/useEditorSync';
import { ActivityBar } from './layout/ActivityBar';
import { SideBar } from './layout/SideBar';
import { StatusBar } from './layout/StatusBar';
import { BottomPanel } from './panel/BottomPanel';
import { QuickOpen } from './quick-open/QuickOpen';
import { useQuickOpen } from './quick-open/quick-open-store';

/**
 * Forge laid out like VS Code (D299, design §2.2): activity bar, side bar, editor, bottom panel and
 * status bar. Every panel is resizable (sizes saved by react-resizable-panels under `autoSaveId`)
 * and hideable (visibility in the layout store); a hidden panel is not rendered, so each
 * combination keeps its own remembered sizes. The chat column is the layout's, not Forge's.
 */
export function ForgeWorkbench({ projectId }: { projectId: string }) {
  const sidebarOpen = useLayoutStore((s) => s.sidebarOpen);
  const panelOpen = useLayoutStore((s) => s.panelOpen);
  const maximized = useLayoutStore((s) => s.panelMaximized);
  const toggleSidebar = useLayoutStore((s) => s.toggleSidebar);
  const togglePanel = useLayoutStore((s) => s.togglePanel);
  const queryClient = useQueryClient();
  const closeRequest = useCloseRequest(projectId);
  useEditorSync(projectId);
  const activePath = (): string | undefined =>
    useEditorStore.getState().projects[projectId]?.active;
  useShortcuts([
    [SHORTCUTS.toggleSidebar, toggleSidebar],
    [SHORTCUTS.togglePanel, togglePanel],
    [SHORTCUTS.quickOpen, () => useQuickOpen.getState().show()],
    [
      SHORTCUTS.save,
      () => {
        const active = activePath();
        if (active !== undefined) void saveFile(projectId, active, queryClient);
      },
    ],
    [SHORTCUTS.saveAll, () => void saveAll(projectId, queryClient)],
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
    <div data-testid="forge" className="flex h-full min-h-0 min-w-0 flex-col bg-canvas">
      <div className="flex min-h-0 flex-1">
        <ActivityBar />
        <PanelGroup
          direction="horizontal"
          autoSaveId="ace.forge.columns"
          className="min-h-0 min-w-0 flex-1"
        >
          {sidebarOpen && (
            <>
              <Panel
                id="forge-sidebar"
                order={1}
                defaultSize={22}
                minSize={12}
                maxSize={45}
                className="min-h-0 min-w-0"
              >
                <SideBar projectId={projectId} />
              </Panel>
              <PanelResizeHandle className={RESIZE_HANDLE_X} />
            </>
          )}
          <Panel id="forge-main" order={2} minSize={30} className="min-h-0 min-w-0">
            <PanelGroup direction="vertical" autoSaveId="ace.forge.rows" className="h-full">
              {showEditor && (
                <Panel id="forge-editor" order={1} minSize={20} className="min-h-0 min-w-0">
                  <EditorArea projectId={projectId} />
                </Panel>
              )}
              {panelOpen && (
                <>
                  {showEditor && <PanelResizeHandle className={RESIZE_HANDLE_Y} />}
                  <Panel
                    id="forge-panel"
                    order={2}
                    defaultSize={30}
                    minSize={10}
                    className="min-h-0 min-w-0"
                  >
                    <BottomPanel projectId={projectId} />
                  </Panel>
                </>
              )}
            </PanelGroup>
          </Panel>
        </PanelGroup>
      </div>
      {closeRequest.dialog}
      <QuickOpen projectId={projectId} />
      <StatusBar projectId={projectId} />
    </div>
  );
}
