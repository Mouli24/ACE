import { cn } from '@ace/ui';
import { Maximize2, Minimize2, X } from 'lucide-react';

import { useLayoutStore, type ForgePanelTab } from '../../app/stores/layout';
import { IconAction } from '../layout/IconAction';
import { OutputView } from './OutputView';

/** Phase 1: Problems (Task 18) and Output. The Terminal arrives in Phase 2 with its view. */
const TABS: ReadonlyArray<{ tab: ForgePanelTab; label: string }> = [
  { tab: 'output', label: 'Output' },
];

export function BottomPanel({ projectId }: { projectId: string }) {
  const panelTab = useLayoutStore((s) => s.panelTab);
  const showPanel = useLayoutStore((s) => s.showPanel);
  const closePanel = useLayoutStore((s) => s.closePanel);
  const maximized = useLayoutStore((s) => s.panelMaximized);
  const toggleMaximized = useLayoutStore((s) => s.toggleMaximized);
  return (
    <section
      aria-label="Panel"
      className="flex h-full min-h-0 flex-col border-t border-border bg-panel"
    >
      <div className="flex h-8 shrink-0 items-center gap-4 px-3">
        <div role="tablist" aria-label="Panel views" className="flex h-full items-center gap-4">
          {TABS.map(({ tab, label }) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={panelTab === tab}
              onClick={() => showPanel(tab)}
              className={cn(
                'h-full border-b font-machine text-[10.5px] uppercase tracking-[0.1em]',
                panelTab === tab
                  ? 'border-fg text-fg'
                  : 'border-transparent text-fg-muted hover:text-fg',
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <IconAction
          label={maximized ? 'Restore panel size' : 'Maximize panel'}
          Icon={maximized ? Minimize2 : Maximize2}
          onClick={toggleMaximized}
        />
        <IconAction label="Close panel" Icon={X} onClick={closePanel} />
      </div>
      <div role="tabpanel" className="min-h-0 flex-1">
        {panelTab === 'output' && <OutputView projectId={projectId} />}
      </div>
    </section>
  );
}
