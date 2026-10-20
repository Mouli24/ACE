import type { NodeRun } from '@ace/contracts';
import { AceApiError } from '@ace/sdk';
import { DropdownMenuItem, toast } from '@ace/ui';
import { useEffect } from 'react';

import { RevertAllDialog } from '../forge/changes/RevertAllDialog';
import { useCheckpoint, useCheckpointAction } from '../forge/changes/hooks';
import { pendingFiles } from '../forge/changes/present';
import { stepFilesOf, useOpenInForge } from '../forge/open-in-forge';
import { useNodeRuns, useRuns } from '../runs/hooks';
import { useRunStore } from '../runs/run-store';
import { isLiveRun } from '../runs/selected-run';
import { useWorkflowGraph } from '../workflows/hooks';

/** The words for a revert the engine refuses because the run is still going (D382, 409 run_active). */
export const REVERT_WHILE_RUNNING = "Can't revert while the run is running.";

/**
 * The agentic node's last step: its newest node run in the workflow's newest run, and whether that
 * run is still going. Reads two queries, so it is mounted only while a card's menu is open.
 */
function useLastStep(workflowId: string, nodeId: string) {
  const runs = useRuns(workflowId).data;
  const run = runs?.[0];
  const nodeRuns = useNodeRuns(run?.id).data;
  const nodeRun: NodeRun | undefined = nodeRuns?.filter((each) => each.nodeId === nodeId).at(-1);
  const liveHere = useRunStore((store) => store.active && store.workflowId === workflowId);
  const live = liveHere || (run !== undefined && isLiveRun(run));
  return { run, nodeRun, live };
}

/**
 * D378/D382: an agentic node's card-menu items — Open in Forge (the files of its last step) and
 * Revert step (its step checkpoint, through the existing Revert-all confirm). Revert is disabled
 * while the run is active; the engine's 409 is the backstop.
 */
export function AgenticMenuItems({
  workflowId,
  nodeId,
  onRevert,
}: {
  workflowId: string;
  nodeId: string;
  onRevert: (projectId: string, checkpointId: string) => void;
}) {
  const projectId = useWorkflowGraph(workflowId).data?.workflow.projectId;
  const { run, nodeRun, live } = useLastStep(workflowId, nodeId);
  const open = useOpenInForge(projectId, workflowId);
  const files = stepFilesOf(nodeRun);
  const checkpointId = nodeRun?.workspace?.checkpointId;
  return (
    <>
      <DropdownMenuItem
        disabled={files.length === 0}
        onSelect={() => open(files, run?.id)}
        title={files.length === 0 ? 'This node has not changed any files yet.' : undefined}
      >
        Open in Forge
      </DropdownMenuItem>
      {checkpointId !== undefined && (
        <DropdownMenuItem
          disabled={live || projectId === undefined}
          title={live ? REVERT_WHILE_RUNNING : undefined}
          onSelect={() => {
            if (projectId !== undefined) onRevert(projectId, checkpointId);
          }}
        >
          Revert step
        </DropdownMenuItem>
      )}
    </>
  );
}

/** The confirm for Revert step: the step checkpoint's pending files, then `revert` (D382). */
export function RevertStepDialog({
  projectId,
  checkpointId,
  onClose,
}: {
  projectId: string;
  checkpointId: string;
  onClose: () => void;
}) {
  const checkpoint = useCheckpoint(projectId, checkpointId).data;
  const action = useCheckpointAction(projectId, checkpointId);
  const pending = checkpoint === undefined ? [] : pendingFiles(checkpoint);
  const nothing = checkpoint !== undefined && pending.length === 0;
  useEffect(() => {
    if (!nothing) return;
    toast.message('Nothing left to revert in this step.');
    onClose();
  }, [nothing, onClose]);
  if (checkpoint === undefined || nothing) return null;
  return (
    <RevertAllDialog
      files={pending}
      onConfirm={() =>
        action.mutate(
          { action: 'revert' },
          {
            onError: (error) => {
              if (AceApiError.is(error) && error.code === 'run_active') {
                toast.error(REVERT_WHILE_RUNNING);
              } else if (!(AceApiError.is(error) && error.code === 'checkpoint_conflict')) {
                toast.error(error.message);
              }
            },
          },
        )
      }
      onClose={onClose}
    />
  );
}
