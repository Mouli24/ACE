import type { Project } from '@ace/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeRepository } from '../../__tests__/fake-repository.js';
import { InProcessPubSubStub } from '../../__tests__/pubsub-stub.js';
import { errorCode, routeApp, send } from '../../__tests__/route-app.js';
import { createEventBus } from '../../events/index.js';
import { newId } from '../../ids.js';
import * as engine from '../../index.js';
import { createLogger } from '../../logging/index.js';
import { LOCAL_SCOPE, type EngineEvent } from '../../ports/index.js';
import { createProcessRoutes } from '../routes.js';
import { createProcessService } from '../service.js';
import { fakeRunner, type FakeRunner } from './fake-runner.js';

const FOLDER = 'D:/projects/demo';
const AT = '2026-10-10T10:00:00.000Z';
const logger = createLogger({ level: 'silent', destination: { write: () => undefined } });

let repository: FakeRepository;
let project: Project;
let runner: FakeRunner;
let app: ReturnType<typeof routeApp>;

beforeEach(async () => {
  repository = new FakeRepository();
  project = { id: newId(), name: 'Demo', folderPath: FOLDER, createdAt: AT, updatedAt: AT };
  await repository.projects.create(LOCAL_SCOPE, project);
  runner = fakeRunner({
    scripts: { packageManager: 'pnpm', scripts: [{ name: 'dev', command: 'vite' }] },
  });
  const bus = createEventBus({
    repository,
    scope: LOCAL_SCOPE,
    pubsub: new InProcessPubSubStub<EngineEvent>(),
  });
  app = routeApp(
    createProcessRoutes(
      createProcessService({ repository, scope: LOCAL_SCOPE, runner, bus, logger, batchMs: 5 }),
    ),
  );
});

const base = () => `/projects/${project.id}/processes`;

async function started(body: unknown = { command: 'node -v' }): Promise<string> {
  const response = await send(app, 'POST', base(), body);
  expect(response.status).toBe(201);
  return ((await response.json()) as { processId: string }).processId;
}

describe('D301 the process routes (design §6.3)', () => {
  it('answers 501 when the engine has no process service (D121)', async () => {
    const response = await send(routeApp(createProcessRoutes(undefined)), 'GET', base());
    expect(response.status).toBe(501);
    expect(await errorCode(response)).toBe('not_implemented');
  });

  it('starts a command with 201 and its id, and lists it', async () => {
    const processId = await started({ command: 'node -v', cwd: 'src' });
    expect(runner.last().spec).toEqual({ root: FOLDER, cwd: 'src', command: 'node -v' });
    const listed = (await (await send(app, 'GET', base())).json()) as Array<{ id: string }>;
    expect(listed.map((summary) => summary.id)).toEqual([processId]);
  });

  it('refuses a body that names both a command and a script, or neither, or a script with a cwd', async () => {
    for (const body of [
      { command: 'a', script: 'b' },
      {},
      { command: '' },
      { script: 'dev', cwd: 'web' },
    ]) {
      const response = await send(app, 'POST', base(), body);
      expect(response.status).toBe(400);
      expect(await errorCode(response)).toBe('validation_failed');
    }
  });

  it('answers the scripts at /scripts, not as a process id', async () => {
    const response = await send(app, 'GET', `${base()}/scripts`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      packageManager: 'pnpm',
      scripts: [{ name: 'dev', command: 'vite' }],
    });
  });

  it('answers a process’s detail with the output it kept', async () => {
    const processId = await started();
    runner.last().print('v24.0.0\n');
    const detail = await (await send(app, 'GET', `${base()}/${processId}`)).json();
    expect(detail).toMatchObject({
      id: processId,
      status: 'running',
      output: 'v24.0.0\n',
      truncated: false,
    });
  });

  it('writes input with 204, and answers 409 process_not_running once it has ended', async () => {
    const processId = await started({ command: 'ask' });
    expect(
      (await send(app, 'POST', `${base()}/${processId}/input`, { data: 'Ada\n' })).status,
    ).toBe(204);
    expect(runner.last().written).toEqual(['Ada\n']);
    runner.last().exit(0);
    const late = await send(app, 'POST', `${base()}/${processId}/input`, { data: 'x\n' });
    expect(late.status).toBe(409);
    expect(await errorCode(late)).toBe('process_not_running');
    const tooBig = await send(app, 'POST', `${base()}/${processId}/input`, {
      data: 'x'.repeat(65_537),
    });
    expect(tooBig.status).toBe(400);
  });

  it('stops with 204, and stopping again is 204 too', async () => {
    const processId = await started({ command: 'serve' });
    expect((await send(app, 'POST', `${base()}/${processId}/stop`)).status).toBe(204);
    await vi.waitFor(async () => {
      const detail = (await (await send(app, 'GET', `${base()}/${processId}`)).json()) as {
        status: string;
      };
      expect(detail.status).toBe('exited');
    });
    expect((await send(app, 'POST', `${base()}/${processId}/stop`)).status).toBe(204);
  });

  it('answers 404 for an unknown project or process', async () => {
    for (const [method, path] of [
      ['GET', `/projects/${newId()}/processes`],
      ['GET', `${base()}/${newId()}`],
      ['POST', `${base()}/${newId()}/stop`],
    ] as const) {
      const response = await send(app, method, path);
      expect(response.status, path).toBe(404);
      expect(await errorCode(response)).toBe('not_found');
    }
  });

  it('answers 403 terminal_disabled for a project whose terminal is off', async () => {
    await repository.projects.update(LOCAL_SCOPE, project.id, { terminal: 'off', updatedAt: AT });
    const response = await send(app, 'POST', base(), { command: 'ls' });
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe('terminal_disabled');
  });

  it('is exported from @ace/engine', () => {
    expect(engine.createProcessRoutes).toBe(createProcessRoutes);
    expect(engine.createProcessService).toBe(createProcessService);
  });
});
