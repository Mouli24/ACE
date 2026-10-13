import type { Checkpoint, Project } from '@ace/contracts';
import { beforeEach, describe, expect, it } from 'vitest';

import { FakeRepository } from '../../__tests__/fake-repository.js';
import { InProcessPubSubStub } from '../../__tests__/pubsub-stub.js';
import { errorCode, routeApp, send } from '../../__tests__/route-app.js';
import { createEventBus } from '../../events/index.js';
import { newId } from '../../ids.js';
import * as engine from '../../index.js';
import { createLogger } from '../../logging/index.js';
import { LOCAL_SCOPE, type EngineEvent } from '../../ports/index.js';
import { createCheckpointRoutes } from '../routes.js';
import { createCheckpointService, type CheckpointService } from '../service.js';
import { fakeCheckpointStore, type FakeCheckpointStore } from './fake-store.js';

const AT = '2026-10-14T10:00:00.000Z';
const logger = createLogger({ level: 'silent', destination: { write: () => undefined } });

let store: FakeCheckpointStore;
let service: CheckpointService;
let project: Project;
let app: ReturnType<typeof routeApp>;

beforeEach(async () => {
  const repository = new FakeRepository();
  store = fakeCheckpointStore();
  project = { id: newId(), name: 'Demo', folderPath: 'D:/demo', createdAt: AT, updatedAt: AT };
  await repository.projects.create(LOCAL_SCOPE, project);
  const bus = createEventBus({
    repository,
    scope: LOCAL_SCOPE,
    pubsub: new InProcessPubSubStub<EngineEvent>(),
  });
  service = createCheckpointService({ store, repository, scope: LOCAL_SCOPE, bus, logger });
  app = routeApp(createCheckpointRoutes(service));
});

const base = () => `/projects/${project.id}/checkpoints`;

async function pending(): Promise<Checkpoint> {
  store.disk.set('a.ts', 'a0\n');
  store.disk.set('b.ts', 'b0\n');
  const recording = await service.begin(project.id, { kind: 'run', runId: newId() });
  store.disk.set('a.ts', 'a1\n');
  store.disk.set('b.ts', 'b1\n');
  return (await recording.finish())!;
}

describe('D300 the checkpoint routes (design §5.3)', () => {
  it('are exported from the engine', () => {
    expect(engine.createCheckpointRoutes).toBe(createCheckpointRoutes);
    expect(engine.createCheckpointService).toBe(createCheckpointService);
  });

  it('answer 501 on every route when the engine has no checkpoint service (D121)', async () => {
    const bare = routeApp(createCheckpointRoutes(undefined));
    const id = newId();
    for (const [method, path, body] of [
      ['GET', base(), undefined],
      ['GET', `${base()}/${id}`, undefined],
      ['GET', `${base()}/${id}/diff?path=a.ts`, undefined],
      ['POST', `${base()}/${id}/actions`, { action: 'keep' }],
    ] as const) {
      const response = await send(bare, method, path, body);
      expect(response.status, path).toBe(501);
      expect(await errorCode(response)).toBe('not_implemented');
    }
  });

  it('lists, gets and diffs a checkpoint, with no store refs on the wire', async () => {
    const checkpoint = await pending();
    const listed = await send(app, 'GET', base());
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as Checkpoint[];
    expect(body.map((each) => each.id)).toEqual([checkpoint.id]);
    expect(Object.keys(body[0] ?? {})).not.toContain('beforeRef');

    const one = await send(app, 'GET', `${base()}/${checkpoint.id}`);
    expect(((await one.json()) as Checkpoint).files).toHaveLength(2);

    const diff = await send(app, 'GET', `${base()}/${checkpoint.id}/diff?path=a.ts`);
    expect(await diff.json()).toEqual({ before: 'a0\n', after: 'a1\n', binary: false });
  });

  it('needs ?path= for a diff, and answers 404 for a path or a checkpoint it does not have', async () => {
    const checkpoint = await pending();
    const noPath = await send(app, 'GET', `${base()}/${checkpoint.id}/diff`);
    expect(noPath.status).toBe(400);
    expect(await errorCode(noPath)).toBe('validation_failed');
    const unknown = await send(app, 'GET', `${base()}/${checkpoint.id}/diff?path=zzz.ts`);
    expect(unknown.status).toBe(404);
    const missing = await send(app, 'GET', `${base()}/${newId()}`);
    expect(missing.status).toBe(404);
  });

  it('keeps and reverts through /actions, and validates the body', async () => {
    const checkpoint = await pending();
    const bad = await send(app, 'POST', `${base()}/${checkpoint.id}/actions`, { action: 'nuke' });
    expect(bad.status).toBe(400);

    const reverted = await send(app, 'POST', `${base()}/${checkpoint.id}/actions`, {
      action: 'revert',
      paths: ['a.ts'],
    });
    expect(reverted.status).toBe(200);
    expect(store.disk.get('a.ts')).toBe('a0\n');
    const kept = await send(app, 'POST', `${base()}/${checkpoint.id}/actions`, { action: 'keep' });
    expect(((await kept.json()) as Checkpoint).status).toBe('partial');
  });

  it('answers 409 checkpoint_conflict with the path when the file changed since', async () => {
    const checkpoint = await pending();
    store.disk.set('a.ts', 'mine\n');
    const response = await send(app, 'POST', `${base()}/${checkpoint.id}/actions`, {
      action: 'revert',
      paths: ['a.ts'],
    });
    expect(response.status).toBe(409);
    const body = (await response.json()) as {
      error: { code: string; message: string; details: unknown };
    };
    expect(body.error.code).toBe('checkpoint_conflict');
    expect(body.error.message).toBe(
      "a.ts changed after the agent's edit; review it before reverting",
    );
    expect(body.error.details).toEqual({
      conflicts: [
        {
          path: 'a.ts',
          message: "a.ts changed after the agent's edit; review it before reverting",
        },
      ],
    });
  });
});
