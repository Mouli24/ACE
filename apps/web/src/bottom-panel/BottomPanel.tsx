import { Tabs, TabsContent, TabsList, TabsTrigger } from '@ace/ui';

import { usePanelsStore, type BottomTab } from '../app/stores/panels';
import { ValidationTab } from './ValidationTab';

const LATER: Array<{ tab: BottomTab; label: string; round: string }> = [
  { tab: 'events', label: 'Events', round: 'Round 3' },
  { tab: 'errors', label: 'Errors', round: 'Round 3' },
  { tab: 'timeline', label: 'Timeline', round: 'Round 4' },
];

/** Bottom pane (Arch §33.1 step 5): Validation now; Events/Errors/Timeline say when they arrive. */
export function BottomPanel({ workflowId }: { workflowId: string }) {
  const tab = usePanelsStore((s) => s.bottomTab);
  const setTab = usePanelsStore((s) => s.setBottomTab);
  return (
    <Tabs
      value={tab}
      onValueChange={(v) => setTab(v as BottomTab)}
      className="flex h-full flex-col bg-panel"
    >
      <TabsList className="px-2">
        <TabsTrigger value="validation">Validation</TabsTrigger>
        {LATER.map((t) => (
          <TabsTrigger key={t.tab} value={t.tab}>
            {t.label}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value="validation" className="min-h-0 flex-1 overflow-auto">
        <ValidationTab workflowId={workflowId} />
      </TabsContent>
      {LATER.map((t) => (
        <TabsContent key={t.tab} value={t.tab} className="p-4 text-sm text-fg-muted">
          {t.label} — available in {t.round}.
        </TabsContent>
      ))}
    </Tabs>
  );
}
