import type { Edge, LoopConfig } from '@ace/contracts';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@ace/ui';
import { useState } from 'react';

import { LoopConfigFields } from './LoopConfigFields';

/**
 * The starting loop for a new loop edge: three iterations, exiting on the review contract's
 * `verdict`, continuing with the last output at the maximum. It is a draft the editor shows rather
 * than something saved behind the operator's back — nothing is sent until they press the button.
 */
export const DEFAULT_LOOP_CONFIG: LoopConfig = {
  maxIterations: 3,
  exitCondition: { path: 'verdict', equals: 'approved' },
  onMax: 'continue',
};

export interface LoopEdgeCandidate {
  from: Edge['from'];
  to: Edge['to'];
  fromNodeName: string;
  toNodeName: string;
  /**
   * Set when an existing data edge is being converted: it is deleted in the same transaction as the
   * loop edge is added, because `update_edge` patches a loop config and cannot change an edge's kind
   * (§2.6, and `loop_config_on_data_edge` is why).
   */
  replacesEdgeId?: string;
}

/**
 * Turning a drawn arrow into the graph's one legal cycle (FR-CON-007, TC-CON-007).
 *
 * The numbers are the editor's, so 0 and 51 iterations are refused inline by the contract's own rule
 * and the Create button stays off until the draft is one the engine would accept — a loop edge never
 * reaches `graph-ops` out of range.
 */
export function MakeLoopEdgeDialog({
  candidate,
  onCancel,
  onCreate,
}: {
  candidate: LoopEdgeCandidate;
  onCancel: () => void;
  onCreate: (loop: LoopConfig) => void;
}) {
  const [loop, setLoop] = useState<LoopConfig>(DEFAULT_LOOP_CONFIG);
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <div className="flex flex-col gap-4" data-testid="make-loop-edge">
          <DialogHeader>
            <DialogTitle>Make this a loop edge?</DialogTitle>
            <DialogDescription>
              {candidate.fromNodeName} would send its output back to {candidate.toNodeName}, and
              everything between them would run again until the exit condition matches. This is the
              only kind of cycle a workflow may have.
            </DialogDescription>
          </DialogHeader>

          <LoopConfigFields value={loop} onCommit={setLoop} />

          <DialogFooter>
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button data-testid="make-loop-edge-create" onClick={() => onCreate(loop)}>
              Create loop edge
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
