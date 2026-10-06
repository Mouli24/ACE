import {
  ApplyTaskRequestSchema,
  CloseTaskRequestSchema,
  CreateTaskRequestSchema,
  PauseTaskRequestSchema,
  ReviewTaskRequestSchema,
  StartWorkRequestSchema,
  TaskListQuerySchema,
  UpdateTaskRequestSchema,
} from '@ace/contracts';
import { Hono } from 'hono';
import { z } from 'zod';

import { notImplemented } from '../gateway/errors.js';
import { readJson } from '../gateway/read-json.js';
import type { TaskService } from './service.js';

/**
 * The task, changes and repository routes (ACE parity P0, p0-tasks-build-design.md §6).
 *
 * Bodies are parsed with their contract schemas; the service answers in the `ApiError` envelope.
 * Lists are `{ items }` (D64), a create is 201, a delete 204. Every action answers with the task as
 * it stands after its synchronous part — a started run is `running`, the rest arrives as
 * `task.updated`. Built without a task service, every route answers 501 (D121).
 */

export type TaskRouter = Hono<{ Variables: { requestId: string } }>;

/** An action body that takes nothing: absent, empty or `{}`. */
const EmptyBodySchema = z.strictObject({});

async function readOptionalJson(c: Parameters<typeof readJson>[0]): Promise<unknown> {
  const text = await c.req.raw.clone().text();
  return text.trim() === '' ? {} : readJson(c);
}

export function createTaskRoutes(taskService: TaskService | undefined): TaskRouter {
  const router: TaskRouter = new Hono<{ Variables: { requestId: string } }>();

  const tasks = (): TaskService => {
    if (taskService === undefined) throw notImplemented('tasks');
    return taskService;
  };

  router.get('/projects/:id/tasks', async (c) => {
    const service = tasks();
    const query = TaskListQuerySchema.parse(c.req.query());
    return c.json({ items: await service.list(c.req.param('id'), query) });
  });

  router.post('/projects/:id/tasks', async (c) => {
    const service = tasks();
    const body = CreateTaskRequestSchema.parse(await readJson(c));
    return c.json(await service.create(c.req.param('id'), body), 201);
  });

  router.get('/projects/:id/repository', async (c) =>
    c.json(await tasks().repository(c.req.param('id'))),
  );

  router.post('/projects/:id/repository/init', async (c) => {
    const service = tasks();
    EmptyBodySchema.parse(await readOptionalJson(c));
    return c.json(await service.initRepository(c.req.param('id')));
  });

  router.get('/tasks/:id', async (c) => c.json(await tasks().get(c.req.param('id'))));

  router.patch('/tasks/:id', async (c) => {
    const service = tasks();
    const patch = UpdateTaskRequestSchema.parse(await readJson(c));
    return c.json(await service.update(c.req.param('id'), patch));
  });

  router.delete('/tasks/:id', async (c) => {
    await tasks().remove(c.req.param('id'));
    return c.body(null, 204);
  });

  router.get('/tasks/:id/activity', async (c) =>
    c.json({ items: await tasks().activity(c.req.param('id')) }),
  );

  const simple = ['start', 'plan', 'stop', 'retry', 'checks'] as const;
  for (const action of simple) {
    router.post(`/tasks/:id/${action}`, async (c) => {
      const service = tasks();
      EmptyBodySchema.parse(await readOptionalJson(c));
      const id = c.req.param('id');
      switch (action) {
        case 'start':
          return c.json(await service.start(id));
        case 'plan':
          return c.json(await service.plan(id));
        case 'stop':
          return c.json(await service.stop(id));
        case 'retry':
          return c.json(await service.retry(id));
        case 'checks':
          return c.json(await service.runChecks(id));
      }
    });
  }

  router.post('/tasks/:id/work', async (c) => {
    const service = tasks();
    const body = StartWorkRequestSchema.parse(await readOptionalJson(c));
    return c.json(await service.work(c.req.param('id'), body));
  });

  router.post('/tasks/:id/review', async (c) => {
    const service = tasks();
    const body = ReviewTaskRequestSchema.parse(await readJson(c));
    return c.json(await service.review(c.req.param('id'), body));
  });

  router.post('/tasks/:id/apply', async (c) => {
    const service = tasks();
    const body = ApplyTaskRequestSchema.parse(await readJson(c));
    return c.json(await service.apply(c.req.param('id'), body));
  });

  router.post('/tasks/:id/close', async (c) => {
    const service = tasks();
    const body = CloseTaskRequestSchema.parse(await readOptionalJson(c));
    return c.json(await service.close(c.req.param('id'), body));
  });

  router.post('/tasks/:id/pause', async (c) => {
    const service = tasks();
    const body = PauseTaskRequestSchema.parse(await readJson(c));
    return c.json(await service.pause(c.req.param('id'), body.paused));
  });

  router.get('/tasks/:id/changes', async (c) => c.json(await tasks().changes(c.req.param('id'))));

  router.get('/tasks/:id/changes/diff', async (c) => {
    const service = tasks();
    const { path } = z.strictObject({ path: z.string().min(1) }).parse(c.req.query());
    return c.json(await service.fileDiff(c.req.param('id'), path));
  });

  return router;
}
