import type { Id, Timestamp } from '@ace/contracts';
import { cn } from '@ace/ui';

import { HELP_CLASS } from '../../config-panel/fields';

import type { MergeMode } from './MergeModeField';

/**
 * One connected input of a merge node. The feeding node's name and the arrival time come in as
 * props — the caller already holds the graph and the run — so this renders the same from a fixture
 * as from a live run.
 */
export interface MergeSlot {
  /** The merge node's input port this edge lands on; the row order is the port order. */
  portId: string;
  portName: string;
  fromNodeId: Id;
  fromNodeName: string;
  /** When this branch's envelope reached the merge. Absent while the branch is still running. */
  arrivedAt?: Timestamp;
}

const ORDINAL = ['1st', '2nd', '3rd'];
const ordinal = (position: number) => ORDINAL[position - 1] ?? `${position}th`;

/**
 * The merge node's input slots (FR-PAR-002): one row per connected input port, in port order —
 * which is the order the merge's json output lists them in — each labelled with the node feeding it.
 *
 * During a run each row says whether that branch has arrived and in which position, so "waiting on
 * the slow branch" and "first past the post" are both visible at a glance. In `any` mode the first
 * arrival is the one that feeds the merge; the rest still complete and are recorded, and the rows
 * say so rather than pretending they were ignored.
 */
export function MergeSlots({ slots, mode }: { slots: readonly MergeSlot[]; mode: MergeMode }) {
  if (slots.length === 0) {
    return (
      <p className={HELP_CLASS} data-testid="merge-slots-empty">
        Nothing is connected to this merge yet.
      </p>
    );
  }

  const arrivalOrder = slots
    .filter((slot) => slot.arrivedAt !== undefined)
    .sort((a, b) => (a.arrivedAt ?? '').localeCompare(b.arrivedAt ?? ''))
    .map((slot) => slot.portId);

  return (
    <div className="flex min-w-0 flex-col gap-[7px]" data-testid="merge-slots">
      <ul className="flex flex-col gap-1">
        {slots.map((slot) => {
          const position = arrivalOrder.indexOf(slot.portId) + 1;
          const arrived = position > 0;
          const feeds = mode === 'all' ? arrived : position === 1;
          return (
            <li
              key={slot.portId}
              data-testid={`merge-slot-${slot.portName}`}
              data-arrival={arrived ? String(position) : 'waiting'}
              className="flex items-center justify-between gap-2.5 rounded-[9px] border border-[var(--line)] px-3 py-2.5"
            >
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-[12.5px] font-semibold text-[var(--ink)]">
                  {slot.fromNodeName}
                </span>
                <span className="font-machine text-[10.5px] text-[var(--muted)]">
                  {slot.portName}
                </span>
              </span>
              <span
                className={cn(
                  'shrink-0 font-machine text-[11px]',
                  arrived ? 'text-[var(--ink)]' : 'text-[var(--muted)]',
                )}
              >
                {arrived ? `${ordinal(position)} to arrive` : 'waiting'}
                {arrived && !feeds && <span className="text-[var(--muted)]"> · recorded only</span>}
              </span>
            </li>
          );
        })}
      </ul>
      <p className={HELP_CLASS}>
        {mode === 'all'
          ? 'Waits for every input; the output lists them in port order.'
          : 'Continues on the first to arrive; the rest still run and are recorded.'}
      </p>
    </div>
  );
}
