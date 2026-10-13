import { describe, expect, it } from 'vitest';

import {
  CHECKPOINT_STATUSES,
  CheckpointActionSchema,
  CheckpointConflictDetailsSchema,
  CheckpointFileDiffSchema,
  CheckpointSchema,
  CheckpointUpdatedPayloadSchema,
} from '../checkpoints.js';
import { ProjectEventSchema } from '../events.js';
import * as contracts from '../index.js';

const ID = '01JBXQ8Z9KQ4R7N2VWXYZ0CKPT';
const PROJECT = '01JBXQ8Z9KQ4R7N2VWXYZ0PRJC';
const AT = '2026-10-14T10:00:00.000Z';

const checkpoint = {
  id: ID,
  projectId: PROJECT,
  kind: 'run',
  runId: '01JBXQ8Z9KQ4R7N2VWXYZ0RNN0',
  status: 'pending',
  files: [
    {
      path: 'src/app.ts',
      change: 'modified',
      additions: 3,
      deletions: 1,
      binary: false,
      state: 'pending',
    },
  ],
  skipped: ['assets/video.mp4'],
  createdAt: AT,
  updatedAt: AT,
};

describe('D300 the checkpoint contract', () => {
  it('parses a run checkpoint with its files, as the wire carries it', () => {
    expect(CheckpointSchema.parse(checkpoint)).toEqual(checkpoint);
  });

  it('names the six statuses a checkpoint moves through', () => {
    expect([...CHECKPOINT_STATUSES]).toEqual([
      'recording',
      'pending',
      'kept',
      'reverted',
      'partial',
      'failed',
    ]);
  });

  it('never carries the store refs: the before and after commits are server-only', () => {
    expect(CheckpointSchema.safeParse({ ...checkpoint, beforeRef: 'abc' }).success).toBe(false);
  });

  it('refuses a file change the diff never produces', () => {
    const file = { ...checkpoint.files[0], change: 'renamed' };
    expect(CheckpointSchema.safeParse({ ...checkpoint, files: [file] }).success).toBe(false);
  });

  it('takes keep or revert, for every pending file or for named paths', () => {
    expect(CheckpointActionSchema.parse({ action: 'keep' })).toEqual({ action: 'keep' });
    expect(CheckpointActionSchema.parse({ action: 'revert', paths: ['a.ts'] })).toEqual({
      action: 'revert',
      paths: ['a.ts'],
    });
    expect(CheckpointActionSchema.safeParse({ action: 'discard' }).success).toBe(false);
    expect(CheckpointActionSchema.safeParse({ action: 'keep', paths: [] }).success).toBe(false);
  });

  it('answers a file diff as two texts, or binary with none', () => {
    expect(CheckpointFileDiffSchema.parse({ before: 'a', after: 'b', binary: false })).toEqual({
      before: 'a',
      after: 'b',
      binary: false,
    });
    expect(CheckpointFileDiffSchema.parse({ binary: true })).toEqual({ binary: true });
  });

  it('names each conflicting path in a 409 checkpoint_conflict', () => {
    const details = { conflicts: [{ path: 'a.ts', message: 'a.ts changed.' }] };
    expect(CheckpointConflictDetailsSchema.parse(details)).toEqual(details);
  });

  it('rides the project scope as a transient checkpoint.updated frame', () => {
    const payload = { projectId: PROJECT, checkpoint };
    expect(CheckpointUpdatedPayloadSchema.parse(payload)).toEqual(payload);
    const frame = { type: 'checkpoint.updated', payload };
    expect(ProjectEventSchema.parse(frame)).toEqual(frame);
    expect(ProjectEventSchema.safeParse({ ...frame, seq: 3 }).success, 'transient').toBe(false);
    const removed = { ...payload, removed: true };
    expect(CheckpointUpdatedPayloadSchema.parse(removed)).toEqual(removed);
  });

  it('is re-exported by the barrel', () => {
    expect(contracts.CheckpointSchema).toBe(CheckpointSchema);
    expect(contracts.ERROR_CODE_HTTP_STATUS.checkpoint_conflict).toBe(409);
    expect(contracts.ERROR_CODE_HTTP_STATUS.checkpoints_unavailable).toBe(503);
  });
});
