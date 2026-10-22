import { LanguageRequestSchema, LanguageServerLanguageSchema } from '@ace/contracts';
import { Hono } from 'hono';

import { notImplemented } from '../gateway/errors.js';
import { readJson } from '../gateway/read-json.js';
import type { LanguageService } from './service.js';

export type LanguageRouter = Hono<{ Variables: { requestId: string } }>;

/**
 * `POST /api/v1/projects/:id/language/:language` — Forge's Python IntelliSense. Mounted inside the
 * gateway's token, Origin and request-id middleware; answers 501 when the engine was built without
 * a language server (D121).
 */
export function createLanguageRoutes(languageService: LanguageService | undefined): LanguageRouter {
  const router: LanguageRouter = new Hono<{ Variables: { requestId: string } }>();

  router.post('/projects/:id/language/:language', async (c) => {
    if (languageService === undefined) throw notImplemented('Python IntelliSense');
    const language = LanguageServerLanguageSchema.parse(c.req.param('language'));
    const body = LanguageRequestSchema.parse(await readJson(c));
    return c.json(
      await languageService.request(c.req.param('id'), language, body, c.req.raw.signal),
    );
  });

  return router;
}
