import type { Node, Part, Run } from '@ace/contracts';
import { useRef, useState, type ReactNode } from 'react';

import { useWorkflowGraph } from '../workflows/hooks';
import { EstimateSummary, overBudget, useWorkflowEstimate } from './estimate';
import { inputNodesNeedingText, useStartRun } from './hooks';
import { useRunStore } from './run-store';
import { useSelectedRun } from './selected-run';
import { InputDialog } from './useStartRunFlow';

/**
 * `@workflow <task>` (chat and Domain): run the whole workflow on a task. The task is the run's
 * goal (D312) and the value of every Input node that would otherwise ask for text, so the input
 * dialog never opens; `extra` parts (attachments, reference chips) ride along with that value. A
 * run that could cost more than the caps leave still asks first (PG-4.3). Once started, the run is
 * selected (`?run=`, PG-3.2), so every mode shows it — a run pre-flight BLOCKED included, whose
 * issues the Run tab's result card says in words.
 */
export function useWorkflowTask(workflowId: string): {
  /** Resolves with the new run, or `undefined` when the person cancelled the budget question. */
  start: (task: string, extra?: readonly Part[]) => Promise<Run | undefined>;
  /** The budget confirmation, to render where the caller is. */
  dialog: ReactNode;
  /** Why `@workflow` cannot start a run right now (one is already going), or nothing. */
  blocked: string | undefined;
  pending: boolean;
} {
  const graph = useWorkflowGraph(workflowId);
  const startRun = useStartRun(workflowId);
  const { select } = useSelectedRun(workflowId);
  const estimate = useWorkflowEstimate(workflowId).data;
  const active = useRunStore((store) => store.workflowId === workflowId && store.active);
  const [confirming, setConfirming] = useState(false);
  const waiting = useRef<((go: boolean) => void) | undefined>(undefined);

  const askBudget = (): Promise<boolean> =>
    new Promise((resolve) => {
      waiting.current = resolve;
      setConfirming(true);
    });

  const answer = (go: boolean) => {
    setConfirming(false);
    waiting.current?.(go);
    waiting.current = undefined;
  };

  const start = async (task: string, extra: readonly Part[] = []): Promise<Run | undefined> => {
    const goal = task.trim();
    if (estimate !== undefined && overBudget(estimate) && !(await askBudget())) return undefined;
    const value: Part[] = [
      ...(goal === '' ? [] : [{ type: 'text' as const, text: goal }]),
      ...extra,
    ];
    const missing = inputNodesNeedingText((graph.data?.nodes ?? []) as Node[]);
    const inputs =
      value.length === 0 ? {} : Object.fromEntries(missing.map((node) => [node.id, value]));
    const run = await startRun.mutateAsync({
      ...(goal === '' ? {} : { goal }),
      ...(Object.keys(inputs).length === 0 ? {} : { inputs }),
    });
    select(run.id);
    return run;
  };

  const dialog = confirming ? (
    <InputDialog
      nodes={[]}
      onCancel={() => answer(false)}
      onSubmit={() => answer(true)}
      {...(estimate === undefined
        ? {}
        : { estimate: <EstimateSummary estimate={estimate} nodes={graph.data?.nodes ?? []} /> })}
    />
  ) : null;

  return {
    start,
    dialog,
    blocked: active
      ? 'A run of this workflow is going — @workflow starts the next one once it has ended.'
      : undefined,
    pending: startRun.isPending,
  };
}
