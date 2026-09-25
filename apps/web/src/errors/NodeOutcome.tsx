import type { Id } from '@ace/contracts';
import { StatusRing } from '@ace/ui';
import { CircleStop, Lock } from 'lucide-react';

/**
 * The two endings that are not failures (FR-ERR-006, FR-ERR-007, TC-ERR-007, TC-ERR-008).
 *
 * BLOCKED is greyed with a lock: nothing went wrong here, the run never reached it. STOPPED is
 * neutral and deliberately never red — a cancellation the operator asked for must not read as a
 * fault, which is what FR-ERR-007 means by "shown differently from failures". Neither component
 * uses a danger colour anywhere, and their tests assert that.
 */

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
      className="flex items-center gap-2 rounded-card border border-border bg-card/60 px-3 py-2 opacity-70 grayscale"
    >
      <Lock className="h-4 w-4 shrink-0 text-fg-muted" aria-label="blocked" />
      <span className="font-human text-sm text-fg-muted">{nodeName}</span>
      <StatusRing state="BLOCKED" showLabel className="ml-auto" />
      <span className="font-human text-xs text-fg-muted">
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
    <div
      data-testid={`stopped-note-${nodeId}`}
      data-state="STOPPED"
      className="flex items-center gap-2 rounded-card border border-border bg-card px-3 py-2"
    >
      <CircleStop className="h-4 w-4 shrink-0 text-status-STOPPED" aria-label="stopped" />
      <span className="font-human text-sm">{nodeName}</span>
      <StatusRing state="STOPPED" showLabel className="ml-auto" />
      <span className="font-human text-xs text-fg-muted">stopped — not a failure</span>
    </div>
  );
}
