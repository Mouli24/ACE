import { z } from 'zod';

import { IdSchema, TimestampSchema } from './graph.js';
import { ProjectPathSchema } from './workspace.js';

/**
 * Checkpoints (D300, design §5): what an agent's writing turn or run changed in the project folder,
 * so a person can review it, keep it or revert it. The file contents live only in the engine's
 * private git store under its data dir (design §7); this seam, the database and the event log carry
 * paths and counts only. The store's before and after commits never leave the engine.
 */

/** What wrote the changes: a chat turn in the project (D302) or a run. */
export const CHECKPOINT_KINDS = ['chat', 'run'] as const;
export const CheckpointKindSchema = z.enum(CHECKPOINT_KINDS);
export type CheckpointKind = z.infer<typeof CheckpointKindSchema>;

/**
 * `recording` while the turn or run is still going; `pending` once it ended with changes to
 * review; `kept`, `reverted` or `partial` (some kept, some reverted) once every file is decided;
 * `failed` when the folder could not be snapshotted (git missing, an unreadable folder), with the
 * reason in `error` — the changes stand, but cannot be reverted (design §10).
 */
export const CHECKPOINT_STATUSES = [
  'recording',
  'pending',
  'kept',
  'reverted',
  'partial',
  'failed',
] as const;
export const CheckpointStatusSchema = z.enum(CHECKPOINT_STATUSES);
export type CheckpointStatus = z.infer<typeof CheckpointStatusSchema>;

/** Without rename detection, a rename is a delete and an add. */
export const CHECKPOINT_FILE_CHANGES = ['added', 'modified', 'deleted'] as const;
export const CheckpointFileChangeSchema = z.enum(CHECKPOINT_FILE_CHANGES);
export type CheckpointFileChange = z.infer<typeof CheckpointFileChangeSchema>;

/**
 * `pending` waits for Keep or Revert; `kept` and `reverted` are decided. Two are never reverted:
 * `person` — the person saved, created, moved or removed it through Forge while the checkpoint was
 * recording, so the change may be theirs — and `not_revertible` — a snapshot could not capture it
 * (`reason` says why), so there is no proof of what it was.
 */
export const CHECKPOINT_FILE_STATES = [
  'pending',
  'kept',
  'reverted',
  'person',
  'not_revertible',
] as const;
export const CheckpointFileStateSchema = z.enum(CHECKPOINT_FILE_STATES);
export type CheckpointFileState = z.infer<typeof CheckpointFileStateSchema>;

/**
 * Why a snapshot left an existing path out: matched by the ignore rules as they were before the
 * agent ran, over 5 MB, unreadable (a link, a locked file, a name git cannot hold), or gone between
 * the listing and the read.
 */
export const CHECKPOINT_UNCAPTURED_REASONS = [
  'ignored',
  'too_large',
  'unreadable',
  'vanished',
] as const;
export const CheckpointUncapturedReasonSchema = z.enum(CHECKPOINT_UNCAPTURED_REASONS);
export type CheckpointUncapturedReason = z.infer<typeof CheckpointUncapturedReasonSchema>;

export const CheckpointFileSchema = z.strictObject({
  path: ProjectPathSchema,
  change: CheckpointFileChangeSchema,
  /** Lines; 0 and 0 for a binary file. */
  additions: z.number().int().min(0),
  deletions: z.number().int().min(0),
  binary: z.boolean(),
  state: CheckpointFileStateSchema,
  /** Set on a `not_revertible` file: why the snapshot could not capture it. */
  reason: CheckpointUncapturedReasonSchema.optional(),
});
export type CheckpointFile = z.infer<typeof CheckpointFileSchema>;

export const CheckpointSchema = z.strictObject({
  id: IdSchema,
  projectId: IdSchema,
  kind: CheckpointKindSchema,
  threadId: IdSchema.optional(),
  /** The chat reply the turn wrote. */
  messageId: IdSchema.optional(),
  runId: IdSchema.optional(),
  nodeId: IdSchema.optional(),
  status: CheckpointStatusSchema,
  files: z.array(CheckpointFileSchema),
  /** Files left out of the snapshot because they are over 5 MB. */
  skipped: z.array(ProjectPathSchema),
  /** Why the checkpoint `failed`, in words. */
  error: z.string().optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Checkpoint = z.infer<typeof CheckpointSchema>;

export const CheckpointListSchema = z.array(CheckpointSchema);

/** `POST /projects/:id/checkpoints/:checkpointId/actions`: without `paths`, every pending file. */
export const CHECKPOINT_ACTIONS = ['keep', 'revert'] as const;
export const CheckpointActionSchema = z.strictObject({
  action: z.enum(CHECKPOINT_ACTIONS),
  paths: z.array(ProjectPathSchema.min(1)).min(1).max(10_000).optional(),
});
export type CheckpointAction = z.infer<typeof CheckpointActionSchema>;

/** The largest text `GET …/diff` sends; a bigger file answers `binary: true`. */
export const CHECKPOINT_DIFF_MAX_BYTES = 2 * 1024 * 1024;

/**
 * `GET /projects/:id/checkpoints/:checkpointId/diff?path=`: the file before and after the agent's
 * change, for Monaco's diff editor. A side is absent when the file did not exist there; a binary or
 * over-2 MB file has neither.
 */
export const CheckpointFileDiffSchema = z.strictObject({
  before: z.string().optional(),
  after: z.string().optional(),
  binary: z.boolean(),
});
export type CheckpointFileDiff = z.infer<typeof CheckpointFileDiffSchema>;

/** `details` of a 409 `checkpoint_conflict`: each file a revert left alone, and why. */
export const CheckpointConflictDetailsSchema = z.object({
  conflicts: z.array(z.object({ path: ProjectPathSchema, message: z.string() })),
});
export type CheckpointConflictDetails = z.infer<typeof CheckpointConflictDetailsSchema>;

/**
 * The transient `checkpoint.updated` frame on the `project` scope. `removed: true` says a recording
 * that ended with nothing changed was dropped: it disappears from the list.
 */
export const CheckpointUpdatedPayloadSchema = z.strictObject({
  projectId: IdSchema,
  checkpoint: CheckpointSchema,
  removed: z.literal(true).optional(),
});
export type CheckpointUpdatedPayload = z.infer<typeof CheckpointUpdatedPayloadSchema>;
