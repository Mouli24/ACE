import { Button } from '@ace/ui';

import { SHORTCUTS, shortcutLabel } from '../../app/shortcuts';
import { useLayoutStore } from '../../app/stores/layout';
import { useExplorerStore } from '../explorer/explorer-store';
import { useQuickOpen } from '../quick-open/quick-open-store';
import { toggleTerminalFocused } from '../terminal/focus';

/** A pill's key, in mono. */
const KEY_HINT = 'font-machine text-[10px] font-medium text-[var(--muted)]';

/**
 * The theme's code view with no file open (D334): one muted line, centred — and under it the real
 * actions (D299, design §2.2) as the theme's Close pills: go to a file, its key in mono; make a new
 * one in the Explorer; or open the Terminal (D301), its key in mono.
 */
export function EmptyEditor({ projectId }: { projectId: string }) {
  const showQuickOpen = useQuickOpen((s) => s.show);
  const newFile = (): void => {
    useLayoutStore.setState({ sidebarOpen: true });
    useExplorerStore.getState().startCreate(projectId, '', 'file');
  };
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-[14px]">
      <p className="text-[13px] text-[var(--muted)]">Open a file from the explorer</p>
      <div className="flex items-center gap-[8px]">
        <Button variant="secondary" size="sm" onClick={showQuickOpen}>
          Go to file <span className={KEY_HINT}>{shortcutLabel(SHORTCUTS.quickOpen)}</span>
        </Button>
        <Button variant="secondary" size="sm" onClick={newFile}>
          New file
        </Button>
        <Button variant="secondary" size="sm" onClick={toggleTerminalFocused}>
          Terminal <span className={KEY_HINT}>{shortcutLabel(SHORTCUTS.toggleTerminal)}</span>
        </Button>
      </div>
    </div>
  );
}
