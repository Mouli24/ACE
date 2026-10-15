import {
  CreateBenchExperimentRequestSchema,
  CreateBenchTaskRequestSchema,
  ImportBenchScoresRequestSchema,
  UpdateBenchExperimentRequestSchema,
  UpdateBenchTaskRequestSchema,
} from '@ace/contracts';
import { Hono } from 'hono';

import { notImplemented } from '../gateway/errors.js';
import { readJson } from '../gateway/read-json.js';
import type { BenchService } from './service.js';

/**
 * ACE Bench's routes (Arch §20.2, PG-5.6, FR-BEN-001..008):
 *
 * - `GET /bench/tasks` → `{ items }` · `POST /bench/tasks` → 201 draft · `GET /bench/tasks/:id`
 * - `PATCH /bench/tasks/:id` → a draft's edit; a frozen task is 409 `bench_task_frozen` (TC-BEN-001)
 * - `POST /bench/tasks/:id/freeze` → the frozen task with its `contentHash`
 * - `GET /bench/experiments` → `{ items }` · `POST /bench/experiments` → 201, every run planned
 * - `GET /bench/experiments/:id` · `PATCH /bench/experiments/:id` → while `draft` only; after start
 *   409 `bench_experiment_locked` (TC-BEN-006)
 * - `POST /bench/experiments/:id/start` → the experiment, once its queue is going
 * - `GET /bench/experiments/:id/blind-export` → `BlindExport` (TC-BEN-004)
 * - `POST /bench/experiments/:id/scores` → `{ imported, unknownLabels }` (TC-BEN-005)
 * - `GET /bench/experiments/:id/report` → `BenchReport`
 *
 * Without a bench service every route answers 501 `not_implemented` (D121).
 */

export type BenchRouter = Hono<{ Variables: { requestId: string } }>;

export function createBenchRoutes(service: BenchService | undefined): BenchRouter {
  const router: BenchRouter = new Hono<{ Variables: { requestId: string } }>();

  const bench = (): BenchService => {
    if (service === undefined) throw notImplemented('bench');
    return service;
  };

  router.get('/bench/tasks', async (c) => c.json({ items: await bench().listTasks() }));
  router.post('/bench/tasks', async (c) => {
    const body = CreateBenchTaskRequestSchema.parse(await readJson(c));
    return c.json(await bench().createTask(body), 201);
  });
  router.get('/bench/tasks/:id', async (c) => c.json(await bench().getTask(c.req.param('id'))));
  router.patch('/bench/tasks/:id', async (c) => {
    const service = bench();
    const body = UpdateBenchTaskRequestSchema.parse(await readJson(c));
    return c.json(await service.updateTask(c.req.param('id'), body));
  });
  router.post('/bench/tasks/:id/freeze', async (c) =>
    c.json(await bench().freezeTask(c.req.param('id'))),
  );

  router.get('/bench/experiments', async (c) => c.json({ items: await bench().listExperiments() }));
  router.post('/bench/experiments', async (c) => {
    const body = CreateBenchExperimentRequestSchema.parse(await readJson(c));
    return c.json(await bench().createExperiment(body), 201);
  });
  router.get('/bench/experiments/:id', async (c) =>
    c.json(await bench().getExperiment(c.req.param('id'))),
  );
  router.patch('/bench/experiments/:id', async (c) => {
    const service = bench();
    const body = UpdateBenchExperimentRequestSchema.parse(await readJson(c));
    return c.json(await service.updateExperiment(c.req.param('id'), body));
  });
  router.post('/bench/experiments/:id/start', async (c) =>
    c.json(await bench().startExperiment(c.req.param('id'))),
  );
  router.get('/bench/experiments/:id/blind-export', async (c) =>
    c.json(await bench().blindExport(c.req.param('id'))),
  );
  router.post('/bench/experiments/:id/scores', async (c) => {
    const service = bench();
    const body = ImportBenchScoresRequestSchema.parse(await readJson(c));
    return c.json(await service.importScores(c.req.param('id'), body));
  });
  router.get('/bench/experiments/:id/report', async (c) =>
    c.json(await bench().report(c.req.param('id'))),
  );

  return router;
}
