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

/**
 * Forge in the Ace UI theme's code view (D334, after D299): a fixed 248px Explorer beside the code
 * column (tabs, path bar, editor). Ctrl/⌘+B hides the Explorer; saving, Save all and closing a tab
 * keep their keys. The chat aside and the footer are the workspace layout's, not Forge's.
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
  const queryClient = useQueryClient();
  const closeRequest = useCloseRequest(projectId);
  const attribution = useForgeAttribution(projectId, workflowId);
  useEditorSync(projectId);
  const activePath = (): string | undefined =>
    useEditorStore.getState().projects[projectId]?.active;
  useShortcuts([
    [SHORTCUTS.toggleSidebar, toggleExplorer],
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

  return (
    <div data-testid="forge" className="flex h-full min-h-0 min-w-0 flex-1">
      {explorerOpen && <ExplorerView projectId={projectId} live={attribution.live} />}
      <EditorArea projectId={projectId} workflowId={workflowId} attribution={attribution} />
      {closeRequest.dialog}
    </div>
  );
}
