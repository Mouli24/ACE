import type { Id, NodeRun, Part } from '@ace/contracts';
import { StatusRing, cn } from '@ace/ui';

/** How much of an output a row shows. Long enough to tell two iterations apart, short enough to scan. */
const PREVIEW_LENGTH = 72;

const LOOP_STOP_LABEL: Record<NonNullable<NodeRun['loopStop']>, string> = {
  exit_condition: 'exit condition met',
  max_iterations: 'hit max iterations',
  repeated_output: 'output repeated',
};

function partPreview(part: Part): string {
  switch (part.type) {
    case 'text':
      return part.text;
    case 'code':
      return part.text;
    case 'json':
      return JSON.stringify(part.value) ?? 'null';
    default:
      return `${part.type} ${part.name}`;
  }
}

/** One line of whatever the iteration produced, or a note that it produced nothing. */
export function outputPreview(output: NodeRun['output']): string {
  if (output === undefined || output.length === 0) return 'no output';
  const text = output.map(partPreview).join(' · ').replace(/\s+/g, ' ').trim();
  if (text === '') return 'no output';
  return text.length > PREVIEW_LENGTH ? `${text.slice(0, PREVIEW_LENGTH)}…` : text;
}

/** Iteration first, then attempt, so a retried iteration stays next to its first try. */
function byIteration(a: NodeRun, b: NodeRun): number {
  return a.iteration - b.iteration || a.attempt - b.attempt;
}

/**
 * Every recorded iteration of one node, selectable (FR-PAR-005, TC-PAR-006).
 *
 * Props in, callback out: the inspector hands over the node runs it already has and is told which
 * one the user picked, so this never reaches for the run store and can be driven straight from a
 * fixture. Each row carries the iteration number, the node state and a short preview of that
 * iteration's output — which is what makes two rounds of a review loop tellable apart — and the
 * iteration that ended the loop says why it ended.
 *
 * In the theme (D328) the rows are its option cards: radius 10, a hairline, 1.5px `#ef6b3f` on the
 * chosen one, the state glyph, a mono label and the preview in muted 12px.
 */
export function IterationSelector({
  runs,
  selectedNodeRunId,
  onSelect,
}: {
  runs: readonly NodeRun[];
  selectedNodeRunId?: Id;
  onSelect: (nodeRunId: Id) => void;
}) {
  if (runs.length === 0) {
    return (
      <p className="m-0 text-[12px] text-[var(--muted)]" data-testid="iteration-selector-empty">
        No iterations recorded.
      </p>
    );
  }

  const ordered = [...runs].sort(byIteration);
  const count = new Set(ordered.map((run) => run.iteration)).size;

  return (
    <div className="flex flex-col gap-2" data-testid="iteration-selector">
      <p className="m-0 font-machine text-[9.5px] font-medium uppercase tracking-[0.1em] text-[var(--muted)]">
        {count} {count === 1 ? 'iteration' : 'iterations'}
      </p>
      <ul
        role="radiogroup"
        aria-label="Iterations"
        className="m-0 flex list-none flex-col gap-[6px] p-0"
      >
        {ordered.map((run) => {
          const selected = run.id === selectedNodeRunId;
          return (
            <li key={run.id}>
              <button
                type="button"
                role="radio"
                aria-checked={selected}
                data-testid={`iteration-option-${run.iteration}${run.attempt > 1 ? `-attempt-${run.attempt}` : ''}`}
                onClick={() => onSelect(run.id)}
                className={cn(
                  'flex w-full cursor-pointer flex-col gap-[3px] rounded-[10px] bg-[var(--surface)] px-3 py-[9px] text-left text-[var(--ink)] outline-none focus-visible:shadow-[0_0_0_2px_var(--focus)]',
                  selected
                    ? 'border-[1.5px] border-[#ef6b3f]'
                    : 'border border-[var(--line)] hover:bg-[var(--hover)]',
                )}
              >
                <span className="flex items-center gap-2 font-machine text-[11.5px]">
                  <StatusRing state={run.status} />
                  <span>iteration {run.iteration}</span>
                  {run.attempt > 1 && (
                    <span className="text-[var(--muted)]">attempt {run.attempt}</span>
                  )}
                  {run.loopStop !== undefined && (
                    <span className="text-[var(--muted)]">{LOOP_STOP_LABEL[run.loopStop]}</span>
                  )}
                </span>
                <span className="truncate text-[12px] text-[var(--muted)]">
                  {outputPreview(run.output)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
