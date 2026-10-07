import {
  BUNDLE_FORMAT,
  BUNDLE_FORMAT_VERSION,
  BundleFileSchema,
  CreateSkillRequestSchema,
  UpdateSkillRequestSchema,
} from '@ace/contracts';
import { Hono } from 'hono';
import { z } from 'zod';

import { notImplemented, unsupportedFormatVersion } from '../gateway/errors.js';
import { readJson } from '../gateway/read-json.js';
import type { SkillService } from './service.js';

/**
 * The skills and bundles routes (ACE parity P1, D272, D273).
 *
 * Bodies are parsed with their contract schemas; the service answers in the `ApiError` envelope.
 * Lists are `{ items }` (D64), a create — a new skill, a duplicate, an import — is 201, a delete
 * 204. Built without a skill service, every route answers 501 (D121).
 */

export type SkillRouter = Hono<{ Variables: { requestId: string } }>;

/** `POST /skills/:id/duplicate` takes nothing: absent, empty or `{}`. */
const EmptyBodySchema = z.strictObject({});

/** Just enough of a bundle file to tell "another format version" from "not a bundle". */
const BundleHeaderSchema = z.object({
  format: z.literal(BUNDLE_FORMAT),
  formatVersion: z.unknown(),
});

export function createSkillRoutes(skillService: SkillService | undefined): SkillRouter {
  const router: SkillRouter = new Hono<{ Variables: { requestId: string } }>();

  const skills = (): SkillService => {
    if (skillService === undefined) throw notImplemented('skills');
    return skillService;
  };

  router.get('/skills', async (c) => c.json({ items: await skills().list() }));

  router.post('/skills', async (c) => {
    const service = skills();
    const body = CreateSkillRequestSchema.parse(await readJson(c));
    return c.json(await service.create(body), 201);
  });

  router.get('/skills/:id', async (c) => c.json(await skills().get(c.req.param('id'))));

  router.patch('/skills/:id', async (c) => {
    const service = skills();
    const patch = UpdateSkillRequestSchema.parse(await readJson(c));
    return c.json(await service.update(c.req.param('id'), patch));
  });

  router.delete('/skills/:id', async (c) => {
    await skills().remove(c.req.param('id'));
    return c.body(null, 204);
  });

  router.post('/skills/:id/duplicate', async (c) => {
    const service = skills();
    EmptyBodySchema.parse(await readJson(c));
    return c.json(await service.duplicate(c.req.param('id')), 201);
  });

  router.get('/bundles', async (c) => c.json({ items: await skills().listBundles() }));

  router.post('/bundles/import', async (c) => {
    const service = skills();
    const raw = await readJson(c);
    // An `ace-bundle` of another version is named as such, the way a workflow import is (§2.7).
    const header = BundleHeaderSchema.safeParse(raw);
    if (header.success && header.data.formatVersion !== BUNDLE_FORMAT_VERSION) {
      throw unsupportedFormatVersion(header.data.formatVersion, BUNDLE_FORMAT_VERSION);
    }
    const file = BundleFileSchema.parse(raw);
    return c.json(await service.importBundle(file), 201);
  });

  router.delete('/bundles/:id', async (c) => {
    await skills().removeBundle(c.req.param('id'));
    return c.body(null, 204);
  });

  return router;
}
