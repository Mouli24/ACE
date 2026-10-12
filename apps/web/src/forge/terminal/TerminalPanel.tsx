import { useEffect } from 'react';

import { TerminalView } from './TerminalView';
import { useProjectTerminals, useTerminalStore } from './terminal-store';

/**
 * The bottom panel's Terminal view (D301), in the theme (D334): the active tab in a surface card,
 * as Problems shows a file. Opening it with no tab opens one.
 */
export function TerminalPanel({ projectId }: { projectId: string }) {
  const terminals = useProjectTerminals(projectId);
  useEffect(() => {
    const store = useTerminalStore.getState();
    if ((store.projects[projectId]?.tabs.length ?? 0) === 0) store.newTab(projectId);
  }, [projectId]);
  const active = terminals.tabs.find((tab) => tab.id === terminals.active) ?? terminals.tabs[0];
  return (
    <div data-testid="terminal-panel" className="flex min-h-0 flex-1 flex-col gap-[8px]">
      <div className="flex min-h-0 flex-1 gap-[10px]">
        <div
          data-testid="terminal-card"
          className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[12px] border border-[var(--line)] bg-[var(--surface)]"
        >
          {active !== undefined && (
            <TerminalView key={active.id} projectId={projectId} tabId={active.id} />
          )}
        </div>
      </div>
    </div>
  );
}
