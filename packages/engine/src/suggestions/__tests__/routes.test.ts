import {
  ProjectNoteListResponseSchema,
  ResponsibilitySchema,
  SuggestionListResponseSchema,
  TaskSchema,
} from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { errorCode, routeApp, send } from '../../__tests__/route-app.js';
import { createLogger } from '../../logging/index.js';
import { createTaskHarness } from '../../tasks/__tests__/harness.js';
import { createSuggestionRoutes } from '../routes.js';
import { createSuggestionService } from '../service.js';

describe('ACE parity P2 — suggestion, note and email routes', () => {
  it('answers 501 without the service', async () => {
    const app = routeApp(createSuggestionRoutes(undefined));
    expect(
      (await send(app, 'GET', '/projects/01JBXQ8Z9KQ4R7N2VWXYZ0PRJC/suggestions')).status,
    ).toBe(501);
  });

  it('runs a responsibility, its notes and an email import over HTTP', async () => {
    const h = await createTaskHarness();
    const rows = new Map<string, unknown>();
    const store = <T extends { id: string }>() => ({
      create: async (_s: unknown, row: T) => (rows.set(row.id, row), row),
      get: async (_s: unknown, id: string) => (rows.get(id) as T | undefined) ?? null,
      save: async (_s: unknown, row: T) => (rows.set(row.id, row), row),
      delete: async (_s: unknown, id: string) => rows.delete(id),
    });
    Object.assign(h.repository, {
      responsibilities: {
        ...store(),
        listByProject: async () =>
          [...rows.values()].filter((row) => (row as { kind?: string }).kind !== undefined),
        listWatched: async () => [],
      },
      suggestions: {
        ...store(),
        listByProject: async () => [],
        getByFingerprint: async () => null,
      },
      projectNotes: {
        ...store(),
        listByProject: async () =>
          [...rows.values()].filter((row) => (row as { source?: string }).source !== undefined),
      },
    });
    const service = createSuggestionService({
      repository: h.repository,
      scope: { workspaceId: 'local' },
      bus: h.bus,
      logger: createLogger({ level: 'silent', destination: { write: () => undefined } }),
      createTask: (projectId, body) => h.service.create(projectId, body),
    });
    const app = routeApp(createSuggestionRoutes(service));

    const created = await send(app, 'POST', `/projects/${h.project.id}/responsibilities`, {
      kind: 'software_health',
      title: 'Keep main green',
    });
    expect(created.status).toBe(201);
    const owner = ResponsibilitySchema.parse(await created.json());
    const patched = await send(app, 'PATCH', `/responsibilities/${owner.id}`, { watch: true });
    expect(ResponsibilitySchema.parse(await patched.json()).watch).toBe(true);
    expect((await send(app, 'POST', `/responsibilities/${owner.id}/scan`)).status).toBe(200);
    await service.idle();
    expect(
      SuggestionListResponseSchema.parse(
        await (await send(app, 'GET', `/projects/${h.project.id}/suggestions?status=new`)).json(),
      ).items,
    ).toEqual([]);
    expect(
      await errorCode(await send(app, 'POST', '/suggestions/01JBXQ8Z9KQ4R7N2VWXYZ0SGG1/later')),
    ).toBe('not_found');

    expect(
      (await send(app, 'POST', `/projects/${h.project.id}/notes`, { text: 'Deploy Tuesdays.' }))
        .status,
    ).toBe(201);
    expect(
      ProjectNoteListResponseSchema.parse(
        await (await send(app, 'GET', `/projects/${h.project.id}/notes`)).json(),
      ).items,
    ).toHaveLength(1);

    const imported = await send(app, 'POST', `/projects/${h.project.id}/tasks/import-email`, {
      raw: 'From: a@b.c\nSubject: Hello\n\nBody',
    });
    expect(imported.status).toBe(201);
    expect(TaskSchema.parse(await imported.json()).title).toBe('Hello');
    expect((await send(app, 'DELETE', `/responsibilities/${owner.id}`)).status).toBe(204);
  });
});
