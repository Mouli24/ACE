import { cn } from '@ace/ui';

import { useLayoutStore, type ForgePanelTab } from '../../app/stores/layout';
import { ProblemsView } from './ProblemsView';
import { useProblemsStore } from './problems-store';

/**
 * Phase 1: Problems (Task 18). The Output view left with D334 (its warnings reach the toaster);
 * the Terminal arrives in Phase 2 with its view.
 */
const TABS: ReadonlyArray<{ tab: ForgePanelTab; label: string }> = [
  { tab: 'problems', label: 'Problems' },
];

export function BottomPanel({ projectId }: { projectId: string }) {
  const count = useProblemsStore((s) => (s.byProject[projectId] ?? []).length);
  const panelTab = useLayoutStore((s) => s.panelTab);
  const showPanel = useLayoutStore((s) => s.showPanel);
  const closePanel = useLayoutStore((s) => s.closePanel);
  const maximized = useLayoutStore((s) => s.panelMaximized);
  const toggleMaximized = useLayoutStore((s) => s.toggleMaximized);
  return (
    <section
      aria-label="Panel"
      className={cn(
        'flex min-h-0 flex-col border-t border-border bg-panel',
        maximized ? 'flex-1' : 'h-[232px] shrink-0',
      )}
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
              {tab === 'problems' && count > 0 && (
                <span className="ml-1.5 rounded-chip bg-card px-1.5 text-[10px] text-fg-soft">
                  {count}
                </span>
              )}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <button
          type="button"
          aria-label={maximized ? 'Restore panel size' : 'Maximize panel'}
          title={maximized ? 'Restore panel size' : 'Maximize panel'}
          onClick={toggleMaximized}
          className="text-fg-muted hover:text-fg"
        >
          <span aria-hidden>⛶</span>
        </button>
        <button
          type="button"
          aria-label="Close panel"
          title="Close panel"
          onClick={closePanel}
          className="text-fg-muted hover:text-fg"
        >
          <span aria-hidden>✕</span>
        </button>
      </div>
      <div role="tabpanel" className="min-h-0 flex-1">
        {panelTab === 'problems' && <ProblemsView projectId={projectId} />}
      </div>
    </section>
  );
}
