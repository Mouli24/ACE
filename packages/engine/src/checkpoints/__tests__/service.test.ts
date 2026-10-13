import type { CheckpointUpdatedPayload, Project } from '@ace/contracts';
import { beforeEach, describe, expect, it } from 'vitest';

import { FakeRepository } from '../../__tests__/fake-repository.js';
import { InProcessPubSubStub } from '../../__tests__/pubsub-stub.js';
import { createEventBus } from '../../events/index.js';
import { HttpError } from '../../gateway/errors.js';
import { newId } from '../../ids.js';
import { createLogger } from '../../logging/index.js';
import { LOCAL_SCOPE, type EngineEvent } from '../../ports/index.js';
import { createCheckpointService, type CheckpointService } from '../service.js';
import { fakeCheckpointStore, gitMissing, type FakeCheckpointStore } from './fake-store.js';

const AT = '2026-10-14T10:00:00.000Z';
const logger = createLogger({ level: 'silent', destination: { write: () => undefined } });

let repository: FakeRepository;
let store: FakeCheckpointStore;
let service: CheckpointService;
let frames: CheckpointUpdatedPayload[];
let project: Project;
let clock: number;

beforeEach(async () => {
  repository = new FakeRepository();
  store = fakeCheckpointStore();
  project = { id: newId(), name: 'Demo', folderPath: 'D:/demo', createdAt: AT, updatedAt: AT };
  await repository.projects.create(LOCAL_SCOPE, project);
  const bus = createEventBus({
    repository,
    scope: LOCAL_SCOPE,
    pubsub: new InProcessPubSubStub<EngineEvent>(),
  });
  frames = [];
  await bus.subscribe((event) => {
    if (event.type === 'checkpoint.updated') frames.push(event.payload as CheckpointUpdatedPayload);
  });
  clock = 0;
  service = createCheckpointService({
    store,
    repository,
    scope: LOCAL_SCOPE,
    bus,
    logger,
    // a minute apart, so "newest first" is never a tie
    now: () => new Date(Date.parse(AT) + 60_000 * clock++).toISOString(),
  });
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function recorded(change: () => void, meta = { kind: 'run' as const, runId: newId() }) {
  const recording = await service.begin(project.id, meta);
  change();
  const checkpoint = await recording.finish();
  return { recording, checkpoint };
}

async function conflictOf(promise: Promise<unknown>): Promise<HttpError> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(HttpError);
  return error as HttpError;
}

describe('D300 the checkpoint service: recording', () => {
  it('begin snapshots before, stores a recording and says so; finish records the changed files as pending', async () => {
    store.disk.set('src/a.ts', 'one\ntwo\n');
    const runId = newId();
    const recording = await service.begin(project.id, { kind: 'run', runId });
    await flush();
    expect(frames.map((frame) => frame.checkpoint.status)).toEqual(['recording']);
    expect((await service.get(project.id, recording.id)).status).toBe('recording');

    store.disk.set('src/a.ts', 'one\nTWO\nthree\n');
    store.disk.set('new.md', 'hi\n');
    const checkpoint = await recording.finish();
    expect(checkpoint).toMatchObject({
      id: recording.id,
      projectId: project.id,
      kind: 'run',
      runId,
      status: 'pending',
      skipped: [],
      files: [
        { path: 'new.md', change: 'added', additions: 1, deletions: 0, state: 'pending' },
        { path: 'src/a.ts', change: 'modified', additions: 2, deletions: 1, state: 'pending' },
      ],
    });
    await flush();
    expect(frames.map((frame) => frame.checkpoint.status)).toEqual(['recording', 'pending']);
    // the store's commits never reach the wire
    expect(JSON.stringify(frames)).not.toContain('0000000000000000000000000000000000000001');
  });

  it('drops a recording that changed nothing: no row, no refs, and a removed frame', async () => {
    store.disk.set('a.ts', 'same\n');
    const { recording, checkpoint } = await recorded(() => undefined);
    expect(checkpoint).toBeUndefined();
    await flush();
    expect(frames.at(-1)).toMatchObject({ removed: true, checkpoint: { id: recording.id } });
    expect(store.refs.size).toBe(0);
    expect(await service.list(project.id)).toEqual([]);
  });

  it('finish answers the same checkpoint twice, snapshotting once', async () => {
    const recording = await service.begin(project.id, { kind: 'chat', threadId: newId() });
    store.disk.set('a.ts', 'x\n');
    const [first, second] = await Promise.all([recording.finish(), recording.finish()]);
    expect(first).toEqual(second);
    expect(store.snapshots).toBe(2);
  });

  it('records a failed checkpoint when git is missing, and finish answers it without a snapshot (design §10)', async () => {
    store.failNext = gitMissing();
    const recording = await service.begin(project.id, { kind: 'run', runId: newId() });
    const checkpoint = await recording.finish();
    expect(checkpoint).toMatchObject({ status: 'failed', files: [] });
    expect(checkpoint?.error).toMatch(/git is not installed/);
    expect(store.snapshots).toBe(0);
  });

  it('marks the checkpoint failed when the after snapshot fails', async () => {
    const recording = await service.begin(project.id, { kind: 'run', runId: newId() });
    store.failNext = new Error('disk on fire');
    expect(await recording.finish()).toMatchObject({ status: 'failed', error: 'disk on fire' });
  });

  it('refuses a project with no folder', async () => {
    const bare = { ...project, id: newId(), folderPath: '' };
    await repository.projects.create(LOCAL_SCOPE, bare);
    const error = await conflictOf(service.begin(bare.id, { kind: 'run', runId: newId() }));
    expect(error.code).toBe('invalid_path');
  });
});

describe('D300 the checkpoint service: listing and diffs', () => {
  it('lists pending and recording first, then the rest, newest first in each', async () => {
    store.disk.set('a.ts', '1\n');
    const kept = (await recorded(() => store.disk.set('a.ts', '2\n'))).checkpoint!;
    await service.act(project.id, kept.id, { action: 'keep' });
    const pending = (await recorded(() => store.disk.set('a.ts', '3\n'))).checkpoint!;
    const recording = await service.begin(project.id, { kind: 'run', runId: newId() });

    const listed = await service.list(project.id);
    expect(listed.map((checkpoint) => checkpoint.id)).toEqual([recording.id, pending.id, kept.id]);
  });

  it('answers a file before and after as text; binary or missing sides as such', async () => {
    store.disk.set('a.ts', 'old\n');
    store.disk.set('img.png', new Uint8Array([0, 1, 2]));
    const { checkpoint } = await recorded(() => {
      store.disk.set('a.ts', 'new\n');
      store.disk.set('img.png', new Uint8Array([0, 9]));
      store.disk.set('added.ts', 'fresh\n');
    });
    expect(await service.fileDiff(project.id, checkpoint!.id, 'a.ts')).toEqual({
      before: 'old\n',
      after: 'new\n',
      binary: false,
    });
    expect(await service.fileDiff(project.id, checkpoint!.id, 'added.ts')).toEqual({
      after: 'fresh\n',
      binary: false,
    });
    expect(await service.fileDiff(project.id, checkpoint!.id, 'img.png')).toEqual({
      binary: true,
    });
    const missing = await conflictOf(service.fileDiff(project.id, checkpoint!.id, 'nope.ts'));
    expect(missing.code).toBe('not_found');
  });

  it('answers 404 for a checkpoint of another project', async () => {
    const { checkpoint } = await recorded(() => store.disk.set('a.ts', 'x\n'));
    const error = await conflictOf(service.get(newId(), checkpoint!.id));
    expect(error.code).toBe('not_found');
  });
});

describe('D300 the checkpoint service: keep and revert', () => {
  async function twoFiles() {
    store.disk.set('a.ts', 'a0\n');
    store.disk.set('b.ts', 'b0\n');
    const { checkpoint } = await recorded(() => {
      store.disk.set('a.ts', 'a1\n');
      store.disk.set('b.ts', 'b1\n');
    });
    return checkpoint!;
  }

  it('keeps every pending file and closes as kept', async () => {
    const checkpoint = await twoFiles();
    const kept = await service.act(project.id, checkpoint.id, { action: 'keep' });
    expect(kept.status).toBe('kept');
    expect(kept.files.map((file) => file.state)).toEqual(['kept', 'kept']);
    expect(store.disk.get('a.ts')).toBe('a1\n');
  });

  it('reverts one file and stays pending; keeping the other closes it as partial', async () => {
    const checkpoint = await twoFiles();
    const reverted = await service.act(project.id, checkpoint.id, {
      action: 'revert',
      paths: ['a.ts'],
    });
    expect(reverted.status).toBe('pending');
    expect(store.disk.get('a.ts')).toBe('a0\n');
    const closed = await service.act(project.id, checkpoint.id, { action: 'keep' });
    expect(closed.status).toBe('partial');
    expect(closed.files.map((file) => `${file.path}:${file.state}`)).toEqual([
      'a.ts:reverted',
      'b.ts:kept',
    ]);
    await flush();
    expect(frames.at(-1)?.checkpoint.status).toBe('partial');
  });

  it('reverts all: a file changed since stays pending and answers 409, the rest are reverted', async () => {
    const checkpoint = await twoFiles();
    store.disk.set('b.ts', 'person edit\n');
    const error = await conflictOf(service.act(project.id, checkpoint.id, { action: 'revert' }));
    expect(error.status).toBe(409);
    expect(error.code).toBe('checkpoint_conflict');
    expect(error.message).toBe("b.ts changed after the agent's edit; review it before reverting");
    expect(error.details).toEqual({
      conflicts: [
        {
          path: 'b.ts',
          message: "b.ts changed after the agent's edit; review it before reverting",
        },
      ],
    });
    expect(store.disk.get('a.ts')).toBe('a0\n');
    expect(store.disk.get('b.ts')).toBe('person edit\n');
    const after = await service.get(project.id, checkpoint.id);
    expect(after.files.map((file) => `${file.path}:${file.state}`)).toEqual([
      'a.ts:reverted',
      'b.ts:pending',
    ]);
    expect(after.status).toBe('pending');
  });

  it('reverting every file closes it as reverted', async () => {
    const checkpoint = await twoFiles();
    expect((await service.act(project.id, checkpoint.id, { action: 'revert' })).status).toBe(
      'reverted',
    );
  });

  it('refuses a path that is not in the checkpoint, and an action while still recording', async () => {
    const checkpoint = await twoFiles();
    const unknown = await conflictOf(
      service.act(project.id, checkpoint.id, { action: 'keep', paths: ['c.ts'] }),
    );
    expect(unknown.code).toBe('not_found');
    const recording = await service.begin(project.id, { kind: 'run', runId: newId() });
    const early = await conflictOf(service.act(project.id, recording.id, { action: 'keep' }));
    expect(early.code).toBe('validation_failed');
  });

  it('answers 503 checkpoints_unavailable when git has gone missing since', async () => {
    const checkpoint = await twoFiles();
    store.revertFile = async () => {
      throw gitMissing();
    };
    const error = await conflictOf(service.act(project.id, checkpoint.id, { action: 'revert' }));
    expect(error.status).toBe(503);
    expect(error.code).toBe('checkpoints_unavailable');
  });
});

describe('D300 the checkpoint service: recover', () => {
  it('marks a recording the last process left as failed, and takes no after snapshot', async () => {
    store.disk.set('a.ts', 'a\n');
    const left = await service.begin(project.id, { kind: 'run', runId: newId() });
    store.disk.set('a.ts', 'b\n');
    const snapshots = store.snapshots;

    await service.recover();

    expect(store.snapshots).toBe(snapshots);
    expect(await service.get(project.id, left.id)).toMatchObject({
      status: 'failed',
      files: [],
      error: "the engine stopped while recording; these changes can't be told apart from yours",
    });
  });
});

describe('D300 the checkpoint service: what it will not revert', () => {
  it('a file the person saved while recording is theirs: listed, not revertible, and Revert all leaves it', async () => {
    store.disk.set('agent.ts', 'a0\n');
    store.disk.set('mine.ts', 'm0\n');
    const recording = await service.begin(project.id, { kind: 'run', runId: newId() });
    store.disk.set('agent.ts', 'a1\n');
    store.disk.set('mine.ts', 'm1\n');
    service.notePersonWrite(project.id, ['mine.ts']);
    const checkpoint = await recording.finish();
    expect(checkpoint?.files.map((file) => `${file.path}:${file.state}`)).toEqual([
      'agent.ts:pending',
      'mine.ts:person',
    ]);

    const reverted = await service.act(project.id, recording.id, { action: 'revert' });
    expect(store.disk.get('agent.ts')).toBe('a0\n');
    expect(store.disk.get('mine.ts')).toBe('m1\n');
    expect(reverted.status).toBe('reverted');
    expect(reverted.files.find((file) => file.path === 'mine.ts')?.state).toBe('person');

    const named = await conflictOf(
      service.act(project.id, recording.id, { action: 'revert', paths: ['mine.ts'] }),
    );
    expect(named.code).toBe('checkpoint_conflict');
    expect(named.message).toBe(
      'You edited mine.ts during the session, so it is not reverted here.',
    );
  });

  it('a person’s write to a folder covers the files under it; another project’s does not count', async () => {
    const recording = await service.begin(project.id, { kind: 'run', runId: newId() });
    store.disk.set('src/a.ts', 'x\n');
    store.disk.set('lib/b.ts', 'y\n');
    service.notePersonWrite(project.id, ['src']);
    service.notePersonWrite(newId(), ['lib/b.ts']);
    const checkpoint = await recording.finish();
    expect(checkpoint?.files.map((file) => `${file.path}:${file.state}`)).toEqual([
      'lib/b.ts:pending',
      'src/a.ts:person',
    ]);
  });

  it('a file the store could not capture is not revertible, with its reason; Revert all skips it', async () => {
    store.disk.set('a.ts', 'a0\n');
    const recording = await service.begin(project.id, { kind: 'run', runId: newId() });
    store.disk.set('a.ts', 'a1\n');
    store.disk.set('big.bin', 'shrunk');
    store.uncaptured.set('big.bin', 'too_large');
    const checkpoint = await recording.finish();
    expect(checkpoint?.files.find((file) => file.path === 'big.bin')).toMatchObject({
      state: 'not_revertible',
      reason: 'too_large',
    });

    const reverted = await service.act(project.id, recording.id, { action: 'revert' });
    expect(reverted.status).toBe('reverted');
    expect(store.disk.get('big.bin')).toBe('shrunk');

    const named = await conflictOf(
      service.act(project.id, recording.id, { action: 'revert', paths: ['big.bin'] }),
    );
    expect(named.message).toBe(
      "ACE could not capture big.bin (over 5 MB), so it can't be reverted",
    );
  });

  it('closes as kept when nothing it recorded can be reverted', async () => {
    const recording = await service.begin(project.id, { kind: 'run', runId: newId() });
    store.disk.set('mine.ts', 'm\n');
    service.notePersonWrite(project.id, ['mine.ts']);
    expect((await recording.finish())?.status).toBe('kept');
  });
});
