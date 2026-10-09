import type { Project } from '@ace/contracts';
import { beforeEach, describe, expect, it } from 'vitest';

import { FakeRepository } from '../../__tests__/fake-repository.js';
import { InProcessPubSubStub } from '../../__tests__/pubsub-stub.js';
import { errorCode, routeApp, send } from '../../__tests__/route-app.js';
import { createEventBus } from '../../events/index.js';
import { newId } from '../../ids.js';
import { createLogger } from '../../logging/index.js';
import {
  LOCAL_SCOPE,
  WorkspaceFsError,
  type EngineEvent,
  type ProjectFiles,
} from '../../ports/index.js';
import { createWorkspaceRoutes } from '../routes.js';
import { createWorkspaceService } from '../service.js';
import { AT, LISTING, SAVED, STATUS, TEXT, fakeFiles } from './fake-files.js';

const FOLDER = 'D:/projects/demo';
const logger = createLogger({ level: 'silent', destination: { write: () => undefined } });

let repository: FakeRepository;
let project: Project;
let files: ReturnType<typeof fakeFiles>;
let app: ReturnType<typeof routeApp>;

function appOver(projectFiles: ProjectFiles): ReturnType<typeof routeApp> {
  const bus = createEventBus({
    repository,
    scope: LOCAL_SCOPE,
    pubsub: new InProcessPubSubStub<EngineEvent>(),
  });
  return routeApp(
    createWorkspaceRoutes(
      createWorkspaceService({ repository, scope: LOCAL_SCOPE, files: projectFiles, bus, logger }),
    ),
  );
}

beforeEach(async () => {
  repository = new FakeRepository();
  project = { id: newId(), name: 'Demo', folderPath: FOLDER, createdAt: AT, updatedAt: AT };
  await repository.projects.create(LOCAL_SCOPE, project);
  files = fakeFiles();
  app = appOver(files);
});

const base = () => `/projects/${project.id}/files`;
const body = { path: 'a.ts', content: 'y', baseVersion: 'v1', eol: 'lf', bom: false };

describe('D299 FR-GIT-003 the project file routes', () => {
  it('answers 501 when the engine has no workspace service (D121)', async () => {
    const response = await send(
      routeApp(createWorkspaceRoutes(undefined)),
      'GET',
      `${base()}/tree`,
    );
    expect(response.status).toBe(501);
    expect(await errorCode(response)).toBe('not_implemented');
  });

  it('answers 404 for a project that does not exist', async () => {
    const response = await send(app, 'GET', `/projects/${newId()}/files/tree`);
    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe('not_found');
  });

  it('lists the root by default and a folder by path, inside the project folder', async () => {
    expect(await (await send(app, 'GET', `${base()}/tree`)).json()).toEqual(LISTING);
    await send(app, 'GET', `${base()}/tree?path=${encodeURIComponent('src/My Dir')}`);
    expect(files.calls).toEqual([
      ['listFolder', FOLDER, ''],
      ['listFolder', FOLDER, 'src/My Dir'],
    ]);
  });

  it('reads a file, and requires its path', async () => {
    expect(await (await send(app, 'GET', `${base()}/content?path=a.ts`)).json()).toEqual(TEXT);
    const missing = await send(app, 'GET', `${base()}/content`);
    expect(missing.status).toBe(400);
    expect(await errorCode(missing)).toBe('validation_failed');
  });

  it('saves with PUT and validates the body (FR-GIT-004)', async () => {
    const response = await send(app, 'PUT', `${base()}/content`, body);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(SAVED);
    expect(files.calls).toContainEqual(['write', FOLDER, body]);
    expect((await send(app, 'PUT', `${base()}/content`, { path: 'a.ts' })).status).toBe(400);
  });

  it('keeps the adapter’s refusal: a stale save is 409 with the disk’s version', async () => {
    app = appOver(
      fakeFiles({
        write: async () => {
          throw new WorkspaceFsError('file_changed', 'a.ts changed on disk.', {
            currentVersion: 'v9',
          });
        },
      }),
    );
    const response = await send(app, 'PUT', `${base()}/content`, body);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: 'file_changed', details: { currentVersion: 'v9' } },
    });
  });

  it('creates (201), moves (200) and deletes (204)', async () => {
    expect(
      (await send(app, 'POST', `${base()}/entries`, { path: 'n.ts', kind: 'file' })).status,
    ).toBe(201);
    const moved = await send(app, 'POST', `${base()}/move`, { from: 'n.ts', to: 'b/n.ts' });
    expect(moved.status).toBe(200);
    expect(((await moved.json()) as { path: string }).path).toBe('b/n.ts');
    expect((await send(app, 'DELETE', `${base()}/entries?path=b%2Fn.ts`)).status).toBe(204);
    expect(files.calls).toEqual([
      ['create', FOLDER, { path: 'n.ts', kind: 'file' }],
      ['move', FOLDER, 'n.ts', 'b/n.ts'],
      ['remove', FOLDER, 'b/n.ts'],
    ]);
  });

  it('serves raw bytes with their type — never sniffed, never cached, sandboxed', async () => {
    const response = await send(app, 'GET', `${base()}/raw?path=a.png`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-security-policy')).toContain('sandbox');
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3]);
  });

  it('lists every file and reads the repository status', async () => {
    expect(await (await send(app, 'GET', `${base()}/list`)).json()).toEqual({
      files: ['a.ts'],
      truncated: false,
    });
    expect(await (await send(app, 'GET', `${base()}/status`)).json()).toEqual(STATUS);
  });

  it('refuses a project with no folder as invalid_path', async () => {
    const bare = { ...project, id: newId(), folderPath: '' };
    await repository.projects.create(LOCAL_SCOPE, bare);
    const response = await send(app, 'GET', `/projects/${bare.id}/files/tree`);
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe('invalid_path');
  });
});
