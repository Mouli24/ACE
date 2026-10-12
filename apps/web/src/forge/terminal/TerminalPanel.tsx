import { useEffect } from 'react';

import { useProject } from '../../projects/hooks';
import { ProcessesList } from './ProcessesList';
import { ScriptButtons } from './ScriptButtons';
import { TerminalTabs } from './TerminalTabs';
import { TerminalView } from './TerminalView';
import { TrustNotice } from './TrustNotice';
import { useProjectTerminals, useTerminalStore } from './terminal-store';

/**
 * The bottom panel's Terminal view (D301, design §6.3) in the theme's code view (D334): a surface
 * card topped by the editor's tab strip — the terminal tabs, + and the project's script pills —
 * over the active tab, and the Processes list beside it, carded as Problems is. Opening it with no
 * tab opens one. When the project limits its terminal, a notice says so above the card; with it
 * off, typing, + and the scripts do nothing, while Stop and the list still work.
 */
export function TerminalPanel({ projectId }: { projectId: string }) {
  const terminals = useProjectTerminals(projectId);
  const trust = useProject(projectId).data?.terminal ?? 'on';
  const off = trust === 'off';
  useEffect(() => {
    const store = useTerminalStore.getState();
    if ((store.projects[projectId]?.tabs.length ?? 0) === 0) store.newTab(projectId);
  }, [projectId]);
  const active = terminals.tabs.find((tab) => tab.id === terminals.active) ?? terminals.tabs[0];

  return (
    <div data-testid="terminal-panel" className="flex min-h-0 flex-1 flex-col gap-[8px]">
      <TrustNotice projectId={projectId} trust={trust} />
      <div className="flex min-h-0 flex-1 gap-[10px]">
        <div
          data-testid="terminal-card"
          className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[12px] border border-[var(--line)] bg-[var(--surface)]"
        >
          <div className="flex h-[32px] shrink-0 items-stretch border-b border-[var(--line)] bg-[var(--panel)]">
            <TerminalTabs projectId={projectId} disabled={off} />
            <ScriptButtons projectId={projectId} disabled={off} />
          </div>
          {active !== undefined ? (
            <TerminalView
              key={`${projectId}/${active.id}`}
              projectId={projectId}
              tabId={active.id}
              disabled={off}
            />
          ) : (
            <p className="m-0 p-[12px] text-[12px] text-[var(--muted)]">No terminal open.</p>
          )}
        </div>
        <ProcessesList projectId={projectId} />
      </div>
    </div>
  );
}
