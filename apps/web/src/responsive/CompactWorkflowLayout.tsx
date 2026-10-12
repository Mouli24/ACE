import type { Id } from '@ace/contracts';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@ace/ui';
import type { ReactNode } from 'react';

import { ChatPanel } from '../chat';
import { Inspector } from '../inspector/Inspector';
import { MemoryTab } from '../memory/MemoryTab';
import { RunsList } from '../runs/RunsList';
import { ReadOnlyCanvasFrame } from './ReadOnlyCanvasFrame';
import { TOUCH_TARGETS } from './touch';

const TABS = ['Canvas', 'Runs', 'Inspector', 'Chat', 'Memory'] as const;

/**
 * The Canvas screen at phone width (FR-MOB-001/003, Arch §10.3): a monitoring app, not an editor.
 * One pane at a time behind tabs — the read-only Canvas, the workflow's runs, the inspector with
 * the selected node's output, chat, and memory. No palette, no config panel, no resize handles.
 *
 * `canvas` is passed in rather than built here so the page that owns the Canvas decides its props.
 * The tabs are the kit's segmented pill (D328), kept 44px tall for touch (FR-MOB-002).
 */
export function CompactWorkflowLayout({
  workflowId,
  canvas,
}: {
  workflowId: Id;
  canvas: ReactNode;
}) {
  return (
    <Tabs
      defaultValue="Canvas"
      className="flex h-full min-w-0 flex-col bg-[var(--canvas)] text-[var(--ink)]"
      data-testid="compact-workflow"
    >
      <TabsList className="m-2 flex shrink-0 overflow-x-auto">
        {TABS.map((tab) => (
          <TabsTrigger key={tab} value={tab} className="min-h-11 flex-1 px-2">
            {tab}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value="Canvas" className="min-h-0 flex-1">
        <ReadOnlyCanvasFrame>{canvas}</ReadOnlyCanvasFrame>
      </TabsContent>
      <TabsContent value="Runs" className="min-h-0 flex-1 overflow-y-auto p-4">
        <RunsList workflowId={workflowId} />
      </TabsContent>
      <TabsContent value="Inspector" className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4">
        <Inspector workflowId={workflowId} />
      </TabsContent>
      <TabsContent value="Chat" className={`min-h-0 min-w-0 flex-1 ${TOUCH_TARGETS}`}>
        <ChatPanel workflowId={workflowId} />
      </TabsContent>
      <TabsContent value="Memory" className="min-h-0 flex-1 overflow-y-auto p-4">
        <MemoryTab workflowId={workflowId} />
      </TabsContent>
    </Tabs>
  );
}
