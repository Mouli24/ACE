/**
 * Checkpoints (D300) — the part of the port a chat turn needs (D302, Forge phase 3 Track B).
 *
 * Track A owns this file: its `CheckpointStore` port and the contracts' `Checkpoint` type join it at
 * the merge, and the merge keeps Track A's superset. The interface below is the plan's §A3
 * `CheckpointRecorder`, verbatim, so the chat service codes against exactly what the checkpoint
 * service implements. `Checkpoint` is the least the chat reads of it — its id.
 */

/** Until the merge: the one field of contracts' `Checkpoint` (Track A §A2) a chat turn reads. */
interface Checkpoint {
  readonly id: string;
}

export interface CheckpointRecorder {
  begin(projectId: string, meta: CheckpointMeta): Promise<CheckpointRecording>;
}
export interface CheckpointRecording {
  readonly id: string;
  finish(): Promise<Checkpoint | undefined>;
}
export type CheckpointMeta = {
  kind: 'chat' | 'run';
  threadId?: string;
  messageId?: string;
  runId?: string;
  nodeId?: string;
};
