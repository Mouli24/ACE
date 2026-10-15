import { Tabs, TabsContent, TabsList, TabsTrigger } from '@ace/ui';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';

import { ExperimentsTab } from './ExperimentsTab';
import { ResultsTab } from './ResultsTab';
import { TasksTab } from './TasksTab';

/**
 * `/bench` and `/bench/experiments/:experimentId` — ACE Bench (PG-5.6, FR-BEN-001..008, Arch
 * §33.3). Three tabs: Tasks (draft, freeze), Experiments (plan, pre-register, start, progress) and
 * Results (blind export, score import, report). Every number is the engine's; there is no demo
 * data. Bench runs open from here only — the Runs list, the timeline and Domain leave them out
 * (FR-BEN-008).
 */

const TABS = ['tasks', 'experiments', 'results'] as const;
type Tab = (typeof TABS)[number];

export function BenchPage() {
  const { experimentId } = useParams();
  const [search, setSearch] = useSearchParams();
  const navigate = useNavigate();
  const requested = search.get('tab');
  const tab: Tab = TABS.includes(requested as Tab)
    ? (requested as Tab)
    : experimentId !== undefined
      ? 'experiments'
      : 'tasks';

  const setTab = (next: string) => {
    const params = new URLSearchParams(search);
    params.set('tab', next);
    setSearch(params, { replace: true });
  };

  const selectExperiment = (id: string | undefined, nextTab: Tab) =>
    navigate(
      id === undefined ? `/bench?tab=${nextTab}` : `/bench/experiments/${id}?tab=${nextTab}`,
    );

  return (
    <main data-testid="bench-page" className="h-full min-w-0 overflow-y-auto">
      <div className="mx-auto flex w-full min-w-0 max-w-[1080px] flex-col gap-6 px-6 py-8">
        <div className="flex flex-col gap-1">
          <h1 className="text-[20px] font-bold tracking-[-0.01em]">Bench</h1>
          <p className="max-w-[720px] text-[12.5px] leading-[1.5] text-[var(--muted)]">
            Does a workflow do better than one model doing the same job alone, with the same tools?
            Freeze the tasks, write down what counts as a win before the first run, judge the
            outputs blind.
          </p>
        </div>
        <Tabs value={tab} onValueChange={setTab} className="flex min-w-0 flex-col gap-4">
          <TabsList className="self-start" aria-label="Bench sections">
            <TabsTrigger value="tasks" data-testid="bench-tab-tasks">
              Tasks
            </TabsTrigger>
            <TabsTrigger value="experiments" data-testid="bench-tab-experiments">
              Experiments
            </TabsTrigger>
            <TabsTrigger value="results" data-testid="bench-tab-results">
              Results
            </TabsTrigger>
          </TabsList>
          <TabsContent value="tasks">
            <TasksTab />
          </TabsContent>
          <TabsContent value="experiments">
            <ExperimentsTab
              selectedId={experimentId}
              onSelect={(id) => selectExperiment(id, 'experiments')}
            />
          </TabsContent>
          <TabsContent value="results">
            <ResultsTab
              selectedId={experimentId}
              onSelect={(id) => selectExperiment(id, 'results')}
            />
          </TabsContent>
        </Tabs>
      </div>
    </main>
  );
}
