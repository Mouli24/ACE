import { Button } from '@ace/ui';

import { SHORTCUTS, shortcutLabel } from '../../app/shortcuts';
import { useLayoutStore } from '../../app/stores/layout';
import { useExplorerStore } from '../explorer/explorer-store';
import { useQuickOpen } from '../quick-open/quick-open-store';

/**
 * The theme's code view with no file open (D334): one muted line, centred — and under it the real
 * actions, with their keys (D299, design §2.2): go to a file, or make a new one in the Explorer.
 */
export function EmptyEditor({ projectId }: { projectId: string }) {
  const showQuickOpen = useQuickOpen((s) => s.show);
  const newFile = (): void => {
    useLayoutStore.setState({ sidebarOpen: true });
    useExplorerStore.getState().startCreate(projectId, '', 'file');
  };
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4">
      <p className="text-[13px] text-[var(--muted)]">Open a file from the explorer</p>
      <div className="flex justify-center gap-2">
        <Button variant="secondary" size="sm" onClick={showQuickOpen}>
          Go to file{' '}
          <span className="font-machine text-fg-faint">{shortcutLabel(SHORTCUTS.quickOpen)}</span>
        </Button>
        <Button variant="secondary" size="sm" onClick={newFile}>
          New file
        </Button>
      </div>
    </div>
  );
}
