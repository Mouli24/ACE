import type { Run } from '@ace/contracts';

import { useRun, useStartRun } from './hooks';
import { useRunStore } from './run-store';

/** PG-2.4 (D361): the words a run or chat turn stops with when its checkpoint cannot begin. */
export const UNDO_UNAVAILABLE_TITLE = "Can't record changes for undo";

/** The engine's message without the title it starts with — the card says the title once. */
export function undoReasonText(message: string): string {
  return message.startsWith(UNDO_UNAVAILABLE_TITLE)
    ? message.slice(UNDO_UNAVAILABLE_TITLE.length).replace(/^[:\s]+/u, '')
    : message;
}

const BUTTON =
  'flex h-[28px] shrink-0 cursor-pointer items-center rounded-[8px] border px-[12px] text-[12px] font-semibold outline-none focus-visible:shadow-[0_0_0_2px_var(--focus)] disabled:cursor-default disabled:opacity-60';

/**
 * The choice a stopped writer offers (PG-2.4, D361): "Run without undo" — once, for this run or
 * turn only — or "Cancel". Shared by the Canvas, Forge and the chat, so the words are the same.
 */
export function UndoChoiceButtons({
  onRunWithoutUndo,
  onCancel,
  busy = false,
}: {
  onRunWithoutUndo: () => void;
  onCancel: () => void;
  busy?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        disabled={busy}
        onClick={onRunWithoutUndo}
        className={`${BUTTON} border-[#c94c27] bg-[#c94c27] text-white hover:bg-[#b2421f]`}
      >
        Run without undo
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={onCancel}
        className={`${BUTTON} border-[var(--line)] bg-[var(--chip)] text-[var(--ink)] hover:bg-[var(--surface)]`}
      >
        Cancel
      </button>
    </div>
  );
}

/** The BLOCKED run's `checkpoint_unavailable` issue, when that is why it stopped. */
export function undoIssueOf(run: Pick<Run, 'status' | 'preflightIssues'> | undefined) {
  if (run?.status !== 'BLOCKED') return undefined;
  return run.preflightIssues.find((issue) => issue.code === 'checkpoint_unavailable');
}

/**
 * The choice for this workflow's current run, wherever the run store says it is BLOCKED (PG-2.4):
 * Forge shows it over its editor, as Ideate's Canvas shows it in the pre-flight notice's place.
 */
export function WorkflowUndoChoice({ workflowId }: { workflowId: string }) {
  const runId = useRunStore((store) => (store.workflowId === workflowId ? store.runId : undefined));
  const status = useRunStore((store) =>
    store.workflowId === workflowId ? store.status : undefined,
  );
  const run = useRun(status === 'BLOCKED' ? runId : undefined);
  if (status !== 'BLOCKED' || run.data === undefined || undoIssueOf(run.data) === undefined) {
    return null;
  }
  return (
    <div className="absolute inset-x-3 top-3 z-20">
      <RunUndoChoice workflowId={workflowId} run={run.data} />
    </div>
  );
}

/**
 * A writing run stopped before its first write because its checkpoint could not begin (PG-2.4).
 * "Run without undo" starts the same run again — its inputs and goal — with `withoutUndo`, which the
 * engine writes to that run's events; "Cancel" dismisses the stopped run.
 */
export function RunUndoChoice({ workflowId, run }: { workflowId: string; run: Run }) {
  const start = useStartRun(workflowId);
  const issue = undoIssueOf(run);
  if (issue === undefined) return null;
  return (
    <section
      role="alert"
      data-testid="undo-choice"
      className="flex flex-col gap-[10px] rounded-[12px] border border-[var(--line)] bg-[var(--surface)] p-[14px] text-[12.5px] text-[var(--ink)] shadow-[0_18px_40px_-16px_rgba(30,20,10,0.45)]"
    >
      <h2 className="m-0 flex items-center gap-2 text-[13px] font-bold">
        <span aria-hidden className="h-[7px] w-[7px] shrink-0 rounded-full bg-[#c94c27]" />
        {UNDO_UNAVAILABLE_TITLE}
      </h2>
      <p className="m-0 whitespace-pre-wrap break-words">{undoReasonText(issue.message)}</p>
      <UndoChoiceButtons
        busy={start.isPending}
        onRunWithoutUndo={() =>
          start.mutate({
            inputs: run.inputs,
            ...(run.goal === undefined ? {} : { goal: run.goal }),
            withoutUndo: true,
          })
        }
        onCancel={() => useRunStore.getState().reset()}
      />
    </section>
  );
}
