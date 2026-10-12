import type { Project } from '@ace/contracts';
import { describe, expect, it, vi } from 'vitest';

import { FakeRepository } from '../../__tests__/fake-repository.js';
import { InProcessPubSubStub } from '../../__tests__/pubsub-stub.js';
import { createEventBus } from '../../events/index.js';
import { createEngineApp } from '../../gateway/index.js';
import { createGraphService } from '../../graph/index.js';
import { newId } from '../../ids.js';
import { createLogger } from '../../logging/index.js';
import { LOCAL_SCOPE, type Auth, type EngineEvent, type Scope } from '../../ports/index.js';
import { createProcessService, type ProcessService } from '../service.js';
import { fakeRunner, type FakeRunnerOptions } from './fake-runner.js';

const TOKEN = 'a'.repeat(64);
const HEADERS = { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
const AT = '2026-10-10T10:00:00.000Z';
const auth: Auth = {
  verifyToken: async (_scope: Scope, token: string | undefined) => token === TOKEN,
};
const logger = createLogger({ level: 'silent', destination: { write: () => undefined } });

async function harness(options: { withTerminal?: boolean; runner?: FakeRunnerOptions } = {}) {
  const repository = new FakeRepository();
  const project: Project = {
    id: newId(),
    name: 'Demo',
    folderPath: 'D:/projects/demo',
    createdAt: AT,
    updatedAt: AT,
  };
  await repository.projects.create(LOCAL_SCOPE, project);
  const bus = createEventBus({
    repository,
    scope: LOCAL_SCOPE,
    pubsub: new InProcessPubSubStub<EngineEvent>(),
  });
  const runner = fakeRunner(options.runner);
  const processes: ProcessService = createProcessService({
    repository,
    scope: LOCAL_SCOPE,
    runner,
    bus,
    logger,
  });
  const app = createEngineApp({
    repository,
    auth,
    logger,
    scope: LOCAL_SCOPE,
    version: '0.1.0',
    graph: createGraphService({ repository, scope: LOCAL_SCOPE, logger }),
    bus,
    ...(options.withTerminal === false ? {} : { processes }),
  });
  const patch = (body: unknown) =>
    app.request(`/api/v1/projects/${project.id}`, {
      method: 'PATCH',
      headers: HEADERS,
      body: JSON.stringify(body),
    });
  const remove = () =>
    app.request(`/api/v1/projects/${project.id}`, { method: 'DELETE', headers: HEADERS });
  return { project, runner, processes, patch, remove };
}

describe('D301 turning the terminal off stops what runs, now', () => {
  it('a PATCH to off stops every running process of the project before it answers', async () => {
    const { project, runner, processes, patch } = await harness();
    const { processId } = await processes.start(project.id, { command: 'serve' });

    const response = await patch({ terminal: 'off' });

    expect(response.status).toBe(200);
    expect(((await response.json()) as Project).terminal).toBe('off');
    expect(runner.last().stops).toBe(1);
    expect((await processes.get(project.id, processId)).status).toBe('exited');
  });

  it('a PATCH to scripts, or one that does not name the terminal, stops nothing', async () => {
    const { project, runner, processes, patch } = await harness();
    await processes.start(project.id, { command: 'serve' });
    expect((await patch({ terminal: 'scripts' })).status).toBe(200);
    expect((await patch({ name: 'Renamed' })).status).toBe(200);
    expect(runner.last().stops).toBe(0);
  });

  it('an engine built without the terminal still takes the PATCH and the DELETE (D121)', async () => {
    const { patch, remove } = await harness({ withTerminal: false });
    const response = await patch({ terminal: 'off' });
    expect(response.status).toBe(200);
    expect(((await response.json()) as Project).terminal).toBe('off');
    expect((await remove()).status).toBe(204);
  });
});

describe('D301 a deleted project leaves nothing running', () => {
  it('deleting a project stops its processes first', async () => {
    const { project, runner, processes, remove } = await harness();
    const { processId } = await processes.start(project.id, { command: 'serve' });

    expect((await remove()).status).toBe(204);

    expect(runner.last().stops).toBe(1);
    // Carried item 1: the records are forgotten once the project is gone.
    await expect(processes.get(project.id, processId)).rejects.toMatchObject({ code: 'not_found' });
    await expect(processes.list(project.id)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('a start that lands while the delete waits is stopped too, never orphaned', async () => {
    const { project, runner, processes, remove } = await harness({
      runner: { exitOnStop: false },
    });
    const a = await processes.start(project.id, { command: 'serve' });
    const first = runner.last();

    const deleting = remove();
    await vi.waitFor(() => expect(first.stops).toBe(1));
    const b = await processes.start(project.id, { command: 'late' });
    const second = runner.last();
    expect(second).not.toBe(first);
    first.exit(null, 'SIGKILL');
    // The second stop now waits on B, which ends after its kill.
    await vi.waitFor(() => expect(second.stops).toBe(1));
    second.exit(null, 'SIGKILL');

    expect((await deleting).status).toBe(204);
    expect(second.stops).toBe(1);
    await expect(processes.get(project.id, b.processId)).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(processes.get(project.id, a.processId)).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});
