import type { Id } from '@ace/contracts';
import { StatusRing } from '@ace/ui';

/**
 * The two endings that are not failures (FR-ERR-006, FR-ERR-007, TC-ERR-007, TC-ERR-008).
 *
 * BLOCKED is greyed with a lock: nothing went wrong here, the run never reached it. STOPPED is
 * neutral and deliberately never red — a cancellation the operator asked for must not read as a
 * fault, which is what FR-ERR-007 means by "shown differently from failures". Neither component
 * uses a danger colour anywhere, and their tests assert that.
 *
 * In the theme (D328) both are 36px rows in a surface card, radius 12; the lock is its 🔒︎ glyph and
 * the stop its ■, both muted.
 */

const ROW =
  'flex min-h-[36px] flex-wrap items-center gap-x-[10px] gap-y-1 rounded-[12px] border border-[var(--line)] bg-[var(--surface)] px-[14px] py-[7px] text-[12.5px]';

export interface BlockedNoteProps {
  nodeId: Id;
  nodeName: string;
  /** The upstream node that failed — `findBlockingNodeId` resolves it from the snapshot. */
  blockedByName?: string;
}

/** A node the run could not reach: greyed, locked, and it names what blocked it (FR-ERR-006). */
export function BlockedNote({ nodeId, nodeName, blockedByName }: BlockedNoteProps) {
  return (
    <div
      data-testid={`blocked-note-${nodeId}`}
      data-state="BLOCKED"
      className={`${ROW} opacity-70 grayscale`}
    >
      <span role="img" aria-label="blocked" className="shrink-0 text-[11px] text-[var(--muted)]">
        🔒︎
      </span>
      <span className="text-[var(--muted)]">{nodeName}</span>
      <StatusRing state="BLOCKED" showLabel className="ml-auto" />
      <span className="text-[11px] text-[var(--muted)]">
        {blockedByName === undefined ? 'blocked upstream' : `blocked by ${blockedByName}`}
      </span>
    </div>
  );
}

export interface StoppedNoteProps {
  nodeId: Id;
  nodeName: string;
}

/** A node the operator stopped: neutral, never red, never counted as a failure (FR-ERR-007). */
export function StoppedNote({ nodeId, nodeName }: StoppedNoteProps) {
  return (
    <div data-testid={`stopped-note-${nodeId}`} data-state="STOPPED" className={ROW}>
      <span
        role="img"
        aria-label="stopped"
        className="shrink-0 text-[10px] text-[var(--color-status-STOPPED)]"
      >
        ■
      </span>
      <span className="text-[var(--ink)]">{nodeName}</span>
      <StatusRing state="STOPPED" showLabel className="ml-auto" />
      <span className="text-[11px] text-[var(--muted)]">stopped — not a failure</span>
    </div>
  );
}
