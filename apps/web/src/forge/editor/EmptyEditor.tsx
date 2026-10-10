import { Button } from '@ace/ui';
import { FilePlus, Search } from 'lucide-react';

import { SHORTCUTS, shortcutLabel, type Shortcut } from '../../app/shortcuts';
import { useLayoutStore } from '../../app/stores/layout';
import { useExplorerStore } from '../explorer/explorer-store';
import { useQuickOpen } from '../quick-open/quick-open-store';

const HINTS: ReadonlyArray<{ label: string; shortcut: Shortcut }> = [
  { label: 'Save', shortcut: SHORTCUTS.save },
  { label: 'Show or hide the Explorer', shortcut: SHORTCUTS.toggleSidebar },
  { label: 'Show or hide the panel', shortcut: SHORTCUTS.togglePanel },
  { label: 'Show or hide the chat', shortcut: SHORTCUTS.toggleChat },
  { label: 'Back to Ideate', shortcut: SHORTCUTS.ideate },
];

/** What the editor area shows with no file open: real actions, with their keys (design §2.2). */
export function EmptyEditor({ projectId }: { projectId: string }) {
  const showQuickOpen = useQuickOpen((s) => s.show);
  const newFile = (): void => {
    useLayoutStore.setState({ sidebarOpen: true, sidebarView: 'explorer' });
    useExplorerStore.getState().startCreate(projectId, '', 'file');
  };
  return (
    <div className="grid h-full place-items-center bg-canvas">
      <div className="space-y-5 text-center">
        <p className="font-human text-2xl text-fg-soft">Forge</p>
        <div className="flex justify-center gap-2">
          <Button variant="secondary" size="sm" onClick={showQuickOpen}>
            <Search className="h-3.5 w-3.5" aria-hidden /> Go to file{' '}
            <span className="font-machine text-fg-faint">{shortcutLabel(SHORTCUTS.quickOpen)}</span>
          </Button>
          <Button variant="secondary" size="sm" onClick={newFile}>
            <FilePlus className="h-3.5 w-3.5" aria-hidden /> New file
          </Button>
        </div>
        <dl className="mx-auto grid w-max grid-cols-[auto_auto] gap-x-6 gap-y-1.5 text-left text-[12px]">
          {HINTS.map(({ label, shortcut }) => (
            <div key={label} className="contents">
              <dt className="text-fg-muted">{label}</dt>
              <dd className="font-machine text-fg-soft">{shortcutLabel(shortcut)}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
