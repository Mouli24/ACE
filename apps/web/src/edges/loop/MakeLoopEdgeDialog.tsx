import type { Edge, LoopConfig } from '@ace/contracts';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@ace/ui';
import { useState } from 'react';

import { LoopConfigFields } from './LoopConfigFields';

/**
 * The starting loop for a new loop edge: three iterations, then the last output goes on. D404: no
 * exit condition — the person says how many times it runs, so it works whatever model the source
 * uses. It is a draft the editor shows rather than something saved behind the operator's back —
 * nothing is sent until they press the button.
 */
export const DEFAULT_LOOP_CONFIG: LoopConfig = {
  maxIterations: 3,
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

/** The theme's footer pills: Close (soft, hairline) and Done (ink on canvas), 34px. */
const PILL_CLASS =
  'h-[34px] cursor-pointer rounded-full px-[22px] text-[13px] font-semibold outline-none focus-visible:shadow-[0_0_0_2px_var(--focus)]';

/**
 * Turning a drawn arrow into the graph's one legal cycle (FR-CON-007, TC-CON-007), in the node
 * settings modal's shell (D328): a header with the title, the loop fields, and a footer.
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
      <DialogContent
        hideClose
        data-cfg="1"
        className="flex w-[560px] max-w-[calc(100vw-48px)] flex-col gap-0 overflow-hidden p-0"
      >
        <div className="flex min-h-0 flex-col" data-testid="make-loop-edge">
          <header className="flex flex-col gap-1 border-b border-[var(--line)] px-5 pb-4 pt-[18px]">
            <DialogTitle>Make this a loop edge?</DialogTitle>
            <DialogDescription>
              {candidate.fromNodeName} will send its output back to {candidate.toNodeName}, and
              everything between them runs again. How many times should it run?
            </DialogDescription>
          </header>

          <div className="min-h-0 overflow-y-auto p-5">
            <LoopConfigFields value={loop} onCommit={setLoop} />
          </div>

          <footer className="flex items-center justify-end gap-2.5 border-t border-[var(--line)] px-5 py-3">
            <button
              type="button"
              className={`${PILL_CLASS} border border-[var(--line)] bg-[var(--soft)] text-[var(--ink)] hover:bg-[var(--hover)]`}
              onClick={onCancel}
            >
              Cancel
            </button>
            <button
              type="button"
              data-testid="make-loop-edge-create"
              className={`${PILL_CLASS} border-none bg-[var(--ink)] text-[var(--canvas)]`}
              onClick={() => onCreate(loop)}
            >
              Create loop edge
            </button>
          </footer>
        </div>
      </DialogContent>
    </Dialog>
  );
}
