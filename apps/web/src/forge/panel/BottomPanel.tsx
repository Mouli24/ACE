import { Badge, Tabs, TabsContent, TabsList, TabsTrigger, cn } from '@ace/ui';

import { useLayoutStore, type ForgePanelTab } from '../../app/stores/layout';
import { ProblemsView } from './ProblemsView';
import { useProblemsStore, type Problem } from './problems-store';

const NONE: Problem[] = [];

/**
 * Phase 1: Problems (Task 18). The Output view left with D334 (its warnings reach the toaster);
 * the Terminal arrives in Phase 2 with its view.
 */
const TABS: ReadonlyArray<{ tab: ForgePanelTab; label: string }> = [
  { tab: 'problems', label: 'Problems' },
];

/** The canvas bottom panel's 28px square (D328), for maximize and close. */
const SQUARE =
  'grid h-7 w-7 shrink-0 cursor-pointer place-items-center rounded-[7px] border border-[var(--line)] bg-transparent text-[var(--ink)] outline-none hover:bg-[var(--hover)] focus-visible:shadow-[0_0_0_2px_#ef6b3f]';

/**
 * Forge's bottom panel (D299), under the code column while the person has it open (Ctrl/⌘+J, or
 * the footer's problem counts), 232px tall or maximized over the editor. In the theme it is the
 * canvas's bottom panel (D332): the kit's segmented pill for the views, the count as a mono chip —
 * red while there are errors — the theme's ⛶ (pressed while maximized) and 28px ✕.
 */
export function BottomPanel({ projectId }: { projectId: string }) {
  const problems = useProblemsStore((s) => s.byProject[projectId] ?? NONE);
  const errors = problems.some((problem) => problem.severity === 'error');
  const panelTab = useLayoutStore((s) => s.panelTab);
  const showPanel = useLayoutStore((s) => s.showPanel);
  const closePanel = useLayoutStore((s) => s.closePanel);
  const maximized = useLayoutStore((s) => s.panelMaximized);
  const toggleMaximized = useLayoutStore((s) => s.toggleMaximized);
  return (
    <section
      aria-label="Panel"
      data-testid="forge-panel"
      className={cn(
        'flex min-h-0 flex-col border-t border-[var(--line)] bg-[var(--panel)] text-[var(--ink)]',
        maximized ? 'flex-1' : 'h-[232px] shrink-0',
      )}
    >
      <Tabs
        value={panelTab}
        onValueChange={(value) => showPanel(value as ForgePanelTab)}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="flex h-11 shrink-0 items-center gap-2 px-[14px]">
          <TabsList aria-label="Panel views">
            {TABS.map(({ tab, label }) => (
              <TabsTrigger key={tab} value={tab} className="flex-none gap-[6px] px-[14px]">
                {label}{' '}
                {tab === 'problems' && problems.length > 0 && (
                  <Badge data-testid="problems-count" variant={errors ? 'danger' : 'default'}>
                    {problems.length}
                  </Badge>
                )}
              </TabsTrigger>
            ))}
          </TabsList>
          <div className="flex-1" />
          <button
            type="button"
            aria-label={maximized ? 'Restore panel size' : 'Maximize panel'}
            title={maximized ? 'Restore panel size' : 'Maximize panel'}
            onClick={toggleMaximized}
            className={cn(SQUARE, 'text-[13px]')}
            style={maximized ? { background: 'var(--hover)', color: '#ef6b3f' } : undefined}
          >
            <span aria-hidden>⛶</span>
          </button>
          <button
            type="button"
            aria-label="Close panel"
            title="Close panel"
            onClick={closePanel}
            className={cn(SQUARE, 'text-[12px]')}
          >
            <span aria-hidden>✕</span>
          </button>
        </div>
        <TabsContent value="problems" className="min-h-0 flex-1 overflow-auto px-[16px] pb-[14px]">
          <ProblemsView projectId={projectId} />
        </TabsContent>
      </Tabs>
    </section>
  );
}
