import { Tabs, TabsContent, TabsList, TabsTrigger } from '@ace/ui';
import { X } from 'lucide-react';

import { usePanelsStore, type SheetTab } from '../app/stores/panels';
import { ConfigPanel } from '../config-panel/ConfigPanel';
import { Inspector } from '../inspector/Inspector';
import { MemoryTab } from '../memory/MemoryTab';
import { RunsList } from '../runs/RunsList';

const TABS: ReadonlyArray<readonly [SheetTab, string]> = [
  ['configure', 'Configure'],
  ['inspect', 'Inspector'],
  ['runs', 'Runs'],
  ['memory', 'Memory'],
];

const isSheetTab = (value: string): value is SheetTab => TABS.some(([tab]) => tab === value);

/** The sheet's element id: the top bar's panel toggle points `aria-controls` at it. */
export const SHEET_ID = 'workflow-sheet';

/**
 * The floating sheet over the Canvas (POC Theme V2): configure what a node will do (FR-NODE-002),
 * inspect what its run did (FR-EXE-010), the workflow's runs and the node's memory. Opened by the
 * node toolbar, a double-click on a node or the top bar's panel toggle; it shows whatever node is
 * selected, so selecting another node — or deleting this one — just changes what it shows.
 */
export function WorkflowSheet({ workflowId }: { workflowId: string }) {
  const open = usePanelsStore((s) => s.sheetOpen);
  const tab = usePanelsStore((s) => s.sheetTab);
  const setTab = usePanelsStore((s) => s.setSheetTab);
  const close = usePanelsStore((s) => s.closeSheet);
  if (!open) return null;

  // Closing unmounts the sheet and the focused Close button with it; rather than drop focus to
  // <body>, hand it to the control that opens the sheet (the top bar's panel toggle).
  const closeToToggle = () => {
    document.querySelector<HTMLElement>(`[aria-controls="${SHEET_ID}"]`)?.focus();
    close();
  };

  return (
    <div
      id={SHEET_ID}
      role="region"
      aria-label="Workflow panel"
      data-testid="workflow-sheet"
      className="absolute bottom-3 right-3 top-3 z-20 flex w-[min(372px,calc(100%-24px))] flex-col rounded-[16px] border border-border-strong bg-panel shadow-[0_24px_60px_-20px_#000000b0,var(--ace-ground)]"
    >
      <Tabs
        value={tab}
        onValueChange={(value) => isSheetTab(value) && setTab(value)}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="flex shrink-0 items-center gap-2 px-2.5 pb-1 pt-2.5">
          <TabsList className="flex flex-1">
            {TABS.map(([value, label]) => (
              <TabsTrigger key={value} value={value}>
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
          <button
            type="button"
            aria-label="Close panel"
            title="Close"
            onClick={closeToToggle}
            className="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-full text-fg-muted transition-colors hover:bg-border hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection"
          >
            <X className="h-[13px] w-[13px]" strokeWidth={2.4} aria-hidden />
          </button>
        </div>
        <div
          data-testid="workflow-sheet-body"
          className="min-h-0 flex-1 overflow-y-auto px-[18px] pb-[18px] pt-1.5"
        >
          <TabsContent value="configure">
            <ConfigPanel workflowId={workflowId} />
          </TabsContent>
          <TabsContent value="inspect">
            <Inspector workflowId={workflowId} />
          </TabsContent>
          <TabsContent value="runs">
            <RunsList workflowId={workflowId} />
          </TabsContent>
          <TabsContent value="memory">
            <MemoryTab workflowId={workflowId} />
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}
