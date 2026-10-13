import type { Project } from '@ace/contracts';
import { beforeEach, describe, expect, it } from 'vitest';

import { FakeRepository } from '../../__tests__/fake-repository.js';
import { InProcessPubSubStub } from '../../__tests__/pubsub-stub.js';
import { createEventBus } from '../../events/index.js';
import { newId } from '../../ids.js';
import { createLogger } from '../../logging/index.js';
import { LOCAL_SCOPE, type EngineEvent, type ProjectFiles } from '../../ports/index.js';
import { createWorkspaceService, type WorkspaceService } from '../service.js';
import { AT, fakeFiles } from './fake-files.js';

const logger = createLogger({ level: 'silent', destination: { write: () => undefined } });

let project: Project;
let writes: Array<[string, string[]]>;

async function serviceOver(files: ProjectFiles): Promise<WorkspaceService> {
  const repository = new FakeRepository();
  project = { id: newId(), name: 'Demo', folderPath: 'D:/demo', createdAt: AT, updatedAt: AT };
  await repository.projects.create(LOCAL_SCOPE, project);
  const bus = createEventBus({
    repository,
    scope: LOCAL_SCOPE,
    pubsub: new InProcessPubSubStub<EngineEvent>(),
  });
  return createWorkspaceService({
    repository,
    scope: LOCAL_SCOPE,
    files,
    bus,
    logger,
    onPersonWrite: (projectId, paths) => {
      writes.push([projectId, paths]);
    },
  });
}

beforeEach(() => {
  writes = [];
});

describe('D300 the person’s own writes are reported, so a checkpoint never claims them', () => {
  it('reports a save, a create, both paths of a move and a remove, after each succeeds', async () => {
    const service = await serviceOver(fakeFiles());
    await service.save(project.id, {
      path: 'a.ts',
      content: 'x',
      baseVersion: 'v1',
      eol: 'lf',
      bom: false,
    });
    await service.create(project.id, { path: 'n.ts', kind: 'file' });
    await service.move(project.id, './n.ts', 'b/n.ts');
    await service.remove(project.id, 'old\\gone.ts');
    expect(writes).toEqual([
      [project.id, ['a.ts']],
      [project.id, ['n.ts']],
      [project.id, ['n.ts', 'b/n.ts']],
      [project.id, ['old/gone.ts']],
    ]);
  });

  it('reports nothing for a write that failed, and never fails a write when the report throws', async () => {
    const failing = await serviceOver(
      fakeFiles({
        write: async () => {
          throw new Error('disk full');
        },
      }),
    );
    await expect(
      failing.save(project.id, {
        path: 'a.ts',
        content: 'x',
        baseVersion: 'v1',
        eol: 'lf',
        bom: false,
      }),
    ).rejects.toThrow('disk full');
    expect(writes).toEqual([]);

    const repository = new FakeRepository();
    await repository.projects.create(LOCAL_SCOPE, project);
    const throwing = createWorkspaceService({
      repository,
      scope: LOCAL_SCOPE,
      files: fakeFiles(),
      bus: createEventBus({
        repository,
        scope: LOCAL_SCOPE,
        pubsub: new InProcessPubSubStub<EngineEvent>(),
      }),
      logger,
      onPersonWrite: () => {
        throw new Error('checkpoint store down');
      },
    });
    await expect(
      throwing.create(project.id, { path: 'n.ts', kind: 'file' }),
    ).resolves.toMatchObject({
      path: 'n.ts',
    });
  });
});
