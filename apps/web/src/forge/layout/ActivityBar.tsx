import { cn } from '@ace/ui';
import { Files, type LucideIcon } from 'lucide-react';

import { SHORTCUTS, shortcutLabel } from '../../app/shortcuts';
import { useLayoutStore, type ForgeView } from '../../app/stores/layout';

/** Phase 1 has the Explorer; Search arrives in Phase 4 and Changes in Phase 3, each with its view. */
const VIEWS: ReadonlyArray<{ view: ForgeView; label: string; Icon: LucideIcon }> = [
  { view: 'explorer', label: 'Explorer', Icon: Files },
];

export function ActivityBar() {
  const sidebarOpen = useLayoutStore((s) => s.sidebarOpen);
  const sidebarView = useLayoutStore((s) => s.sidebarView);
  const showView = useLayoutStore((s) => s.showView);
  return (
    <nav
      aria-label="Forge views"
      className="flex w-11 shrink-0 flex-col items-center gap-1 border-r border-border bg-panel py-2"
    >
      {VIEWS.map(({ view, label, Icon }) => {
        const active = sidebarOpen && sidebarView === view;
        return (
          <button
            key={view}
            type="button"
            aria-label={label}
            aria-pressed={active}
            data-testid={`activity-${view}`}
            title={`${label} (${shortcutLabel(SHORTCUTS.toggleSidebar)})`}
            onClick={() => showView(view)}
            className={cn(
              'relative grid h-10 w-10 place-items-center text-fg-muted hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
              active &&
                'text-fg before:absolute before:left-[-2px] before:h-6 before:w-0.5 before:rounded before:bg-fg',
            )}
          >
            <Icon className="h-5 w-5" aria-hidden />
          </button>
        );
      })}
    </nav>
  );
}
