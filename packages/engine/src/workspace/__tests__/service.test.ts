import type { Project } from '@ace/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeRepository } from '../../__tests__/fake-repository.js';
import { InProcessPubSubStub } from '../../__tests__/pubsub-stub.js';
import { createEventBus } from '../../events/index.js';
import { newId } from '../../ids.js';
import { createLogger } from '../../logging/index.js';
import {
  LOCAL_SCOPE,
  type EngineEvent,
  type FileChangeBatch,
  type ProjectFiles,
} from '../../ports/index.js';
import { createWorkspaceService, type WorkspaceService } from '../service.js';
import { AT, fakeFiles } from './fake-files.js';

const FOLDER = 'D:/projects/demo';
const logger = createLogger({ level: 'silent', destination: { write: () => undefined } });

let repository: FakeRepository;
let project: Project;
let events: EngineEvent[];

beforeEach(async () => {
  repository = new FakeRepository();
  project = { id: newId(), name: 'Demo', folderPath: FOLDER, createdAt: AT, updatedAt: AT };
  await repository.projects.create(LOCAL_SCOPE, project);
  events = [];
});

async function serviceOver(files: ProjectFiles, restartDelayMs = 5): Promise<WorkspaceService> {
  const bus = createEventBus({
    repository,
    scope: LOCAL_SCOPE,
    pubsub: new InProcessPubSubStub<EngineEvent>(),
  });
  await bus.subscribe((event) => events.push(event));
  return createWorkspaceService({
    repository,
    scope: LOCAL_SCOPE,
    files,
    bus,
    logger,
    restartDelayMs,
  });
}

const changedFrames = () => events.filter((event) => event.type === 'files.changed');

describe('D299 a project folder is watched while someone looks at it', () => {
  it('starts one watcher, announces each burst as a transient files.changed, and stops', async () => {
    let started = 0;
    let stopped = 0;
    let report: ((batch: FileChangeBatch) => void) | undefined;
    const service = await serviceOver(
      fakeFiles({
        watch: (root, onChange) => {
          started += 1;
          expect(root).toBe(FOLDER);
          report = onChange;
          return () => {
            stopped += 1;
          };
        },
      }),
    );

    await service.setWatched(project.id, true);
    await service.setWatched(project.id, true);
    expect(started).toBe(1);

    report?.({ changes: [{ path: 'a.ts', kind: 'changed' }], resync: false });
    await vi.waitFor(() =>
      expect(changedFrames()).toEqual([
        expect.objectContaining({
          type: 'files.changed',
          transient: true,
          payload: {
            projectId: project.id,
            changes: [{ path: 'a.ts', kind: 'changed' }],
            resync: false,
          },
        }),
      ]),
    );

    await service.setWatched(project.id, false);
    expect(stopped).toBe(1);
  });

  it('does nothing, and does not throw, for a project that does not exist', async () => {
    let started = 0;
    const service = await serviceOver(
      fakeFiles({
        watch: () => {
          started += 1;
          return () => undefined;
        },
      }),
    );
    await expect(service.setWatched(newId(), true)).resolves.toBeUndefined();
    expect(started).toBe(0);
  });

  it('a watcher that dies announces a resync and starts again while someone still watches', async () => {
    let starts = 0;
    let fail: ((error: Error) => void) | undefined;
    const service = await serviceOver(
      fakeFiles({
        watch: (_root, _onChange, onError) => {
          starts += 1;
          fail = onError;
          return () => undefined;
        },
      }),
    );

    await service.setWatched(project.id, true);
    fail?.(new Error('EPERM: the folder was removed'));

    await vi.waitFor(() =>
      expect(changedFrames().map((event) => event.payload)).toContainEqual({
        projectId: project.id,
        changes: [],
        resync: true,
      }),
    );
    await vi.waitFor(() => expect(starts).toBe(2));
  });

  it('stopAll stops every watcher and cancels a pending restart', async () => {
    let stopped = 0;
    let starts = 0;
    let fail: ((error: Error) => void) | undefined;
    const service = await serviceOver(
      fakeFiles({
        watch: (_root, _onChange, onError) => {
          starts += 1;
          fail = onError;
          return () => {
            stopped += 1;
          };
        },
      }),
      50,
    );
    await service.setWatched(project.id, true);
    fail?.(new Error('gone'));
    service.stopAll();
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(starts).toBe(1);

    await service.setWatched(project.id, true);
    service.stopAll();
    expect(stopped).toBe(1);
  });
});
