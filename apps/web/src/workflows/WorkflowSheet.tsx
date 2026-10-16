import { DIALOG_CLOSE_CLASS, Icons, Tabs, TabsContent, TabsList, TabsTrigger } from '@ace/ui';

import { usePanelsStore, type SheetTab } from '../app/stores/panels';
import { Inspector } from '../inspector/Inspector';
import { MemoryTab } from '../memory/MemoryTab';
import { RunsList } from '../runs/RunsList';

/** D332: the sheet keeps Inspector, Runs and Memory; node and loop-edge config is the modal's. */
const TABS: ReadonlyArray<readonly [SheetTab, string]> = [
  ['inspect', 'Inspector'],
  ['runs', 'Runs'],
  ['memory', 'Memory'],
];

const isSheetTab = (value: string): value is SheetTab => TABS.some(([tab]) => tab === value);

/** The sheet's element id: the control that opens it points `aria-controls` at it. */
export const SHEET_ID = 'workflow-sheet';

/**
 * The floating sheet over the Canvas (D332): inspect what a node's run did (FR-EXE-010), the
 * workflow's runs and the node's memory, in the theme's panel and segmented tabs. Opened from the
 * workspace menu ("Workflow panel") or a node's "Inspect"; it shows whatever node is selected, so
 * selecting another node — or deleting this one — just changes what it shows. Opened without a
 * tab (or on the old Configure tab, which the node settings modal replaced) it shows the Inspector.
 */
export function WorkflowSheet({ workflowId }: { workflowId: string }) {
  const open = usePanelsStore((s) => s.sheetOpen);
  const stored = usePanelsStore((s) => s.sheetTab);
  const setTab = usePanelsStore((s) => s.setSheetTab);
  const close = usePanelsStore((s) => s.closeSheet);
  if (!open) return null;
  const tab = isSheetTab(stored) ? stored : 'inspect';

  // Closing unmounts the sheet and the focused Close button with it; rather than drop focus to
  // <body>, hand it to the control that opens the sheet, when there is one.
  const closeToOpener = () => {
    document.querySelector<HTMLElement>(`[aria-controls="${SHEET_ID}"]`)?.focus();
    close();
  };

  return (
    <div
      id={SHEET_ID}
      role="region"
      aria-label="Workflow panel"
      data-testid="workflow-sheet"
      className="absolute bottom-[12px] right-[12px] top-[58px] z-20 flex w-[min(372px,calc(100%-24px))] flex-col rounded-[12px] border border-[var(--line)] bg-[var(--surface)] text-[var(--ink)] shadow-[0_18px_40px_-16px_rgba(30,20,10,0.45)]"
    >
      <Tabs
        value={tab}
        onValueChange={(value) => isSheetTab(value) && setTab(value)}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="flex shrink-0 items-center gap-[8px] px-[12px] pb-[6px] pt-[12px]">
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
            onClick={closeToOpener}
            className={DIALOG_CLOSE_CLASS}
          >
            <Icons.X aria-hidden size={12} />
          </button>
        </div>
        <div
          data-testid="workflow-sheet-body"
          className="min-h-0 flex-1 overflow-y-auto px-[18px] pb-[18px] pt-1.5"
        >
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
