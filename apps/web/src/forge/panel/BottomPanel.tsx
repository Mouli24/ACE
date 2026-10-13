import { Badge, Tabs, TabsContent, TabsList, TabsTrigger, cn } from '@ace/ui';

import { useLayoutStore, type ForgePanelTab } from '../../app/stores/layout';
import { requestTerminalFocus } from '../terminal/focus';
import { TerminalPanel } from '../terminal/TerminalPanel';
import { ProblemsView } from './ProblemsView';
import { problemCounts, useProblemsStore } from './problems-store';
import { RunChecksButton } from './RunChecksButton';

/**
 * Terminal · Problems (D334 as amended 2026-10-13): the Terminal (D301) first, as VS Code orders
 * them. The Output view left with D334; its warnings reach the toaster.
 */
const TABS: ReadonlyArray<{ tab: ForgePanelTab; label: string }> = [
  { tab: 'terminal', label: 'Terminal' },
  { tab: 'problems', label: 'Problems' },
];

/**
 * A click (or Enter) on the Terminal pill is the person asking for the Terminal, so it takes the
 * focus (D301). Arrowing along the pill only shows it.
 */
const onPick = (tab: ForgePanelTab): (() => void) | undefined =>
  tab === 'terminal' ? () => requestTerminalFocus() : undefined;

/** The canvas bottom panel's 28px square (D328), for maximize and close. */
const SQUARE =
  'grid h-7 w-7 shrink-0 cursor-pointer place-items-center rounded-[7px] border border-[var(--line)] bg-transparent text-[var(--ink)] outline-none hover:bg-[var(--hover)] focus-visible:shadow-[0_0_0_2px_#ef6b3f]';

/**
 * Forge's bottom panel (D299, D334 as amended), under the code column while the person has it open
 * (Ctrl/⌘+J, Ctrl+`, or the footer's counts), 232px tall or maximized over the editor. In the theme
 * it is the canvas's bottom panel (D332): the kit's segmented pill for the views, the problem count
 * as a mono chip — red while there are errors — the theme's ⛶ (pressed while maximized) and 28px ✕.
 */
export function BottomPanel({ projectId }: { projectId: string }) {
  // The open files' markers and Run checks' results together (D299 Phase 4).
  const total = useProblemsStore((s) => problemCounts(s, projectId).total);
  const errors = useProblemsStore((s) => problemCounts(s, projectId).errors > 0);
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
              <TabsTrigger
                key={tab}
                value={tab}
                onClick={onPick(tab)}
                className="flex-none gap-[6px] px-[14px]"
              >
                {label}{' '}
                {tab === 'problems' && total > 0 && (
                  <Badge data-testid="problems-count" variant={errors ? 'danger' : 'default'}>
                    {total}
                  </Badge>
                )}
              </TabsTrigger>
            ))}
          </TabsList>
          <div className="flex-1" />
          {panelTab === 'problems' && <RunChecksButton projectId={projectId} />}
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
        {/* `flex` only while active: Radix hides the inactive content with `hidden`. */}
        <TabsContent
          value="terminal"
          className="min-h-0 flex-1 flex-col px-[16px] pb-[14px] data-[state=active]:flex"
        >
          <TerminalPanel projectId={projectId} />
        </TabsContent>
        <TabsContent value="problems" className="min-h-0 flex-1 overflow-auto px-[16px] pb-[14px]">
          <ProblemsView projectId={projectId} />
        </TabsContent>
      </Tabs>
    </section>
  );
}
