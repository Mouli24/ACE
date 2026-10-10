import { Hono, type Env } from 'hono';
import { streamSSE } from 'hono/streaming';

import { notImplemented } from '../gateway/errors.js';
import { readJson } from '../gateway/read-json.js';
import type { DomainService } from './service.js';

/**
 * Domain's HTTP surface (D309, D314, D323), mounted by the gateway inside `/api/v1` and its auth.
 *
 *   POST /runs/:runId/messages  { text, deliveryMode?, exclude? }  → 201 { messageId, delivery[] }
 *                                400 a bad address (details.errors) · 409 the run has ended
 *   POST /runs/:runId/end                                          → Run
 *   POST /runs/:runId/envelopes/:id/route  { decision, reason?, edit? } → { envelopeId, routing }
 *                                400 a bad edit · 404 no such envelope · 409 not held, or the run has ended
 *   PUT  /runs/:runId/budget  { limit: number | null }            → DomainUsageSnapshot
 *                                400 a bad limit · 409 the run has ended
 *   GET  /runs/:runId/usage                                        → DomainUsageSnapshot
 *   GET  /runs/:runId/chat?node=&after=&limit=                     → { messages, nextCursor? }
 *   GET  /runs/:runId/chat/stream?node=&after=   (SSE, Last-Event-ID) → chat.message | chat.update
 *                                                                    | usage.snapshot | turn.token
 *
 * `resolve` is a getter, as for the run controls: an app built without Domain answers 501.
 */
export function createDomainRoutes<E extends Env>(
  resolve: () => DomainService | undefined,
): Hono<E> {
  const routes = new Hono<E>();

  const domain = (): DomainService => {
    const service = resolve();
    if (service === undefined) throw notImplemented('Domain');
    return service;
  };

  routes.post('/runs/:runId/messages', async (c) => {
    const body = (await readJson(c)) as Parameters<DomainService['postMessage']>[1];
    return c.json(await domain().postMessage(c.req.param('runId'), body), 201);
  });

  routes.post('/runs/:runId/end', async (c) => c.json(await domain().end(c.req.param('runId'))));

  routes.put('/runs/:runId/budget', async (c) => {
    const body = (await readJson(c)) as Parameters<DomainService['setBudget']>[1];
    return c.json(await domain().setBudget(c.req.param('runId'), body));
  });

  routes.get('/runs/:runId/usage', async (c) => c.json(await domain().usage(c.req.param('runId'))));

  routes.get('/runs/:runId/chat', async (c) =>
    c.json(await domain().chat(c.req.param('runId'), c.req.query())),
  );

  routes.get('/runs/:runId/chat/stream', async (c) => {
    // Checked before the stream opens, so a bad query or an unknown run is a plain 400 or 404.
    const session = await domain().chatStream(
      c.req.param('runId'),
      c.req.query(),
      c.req.header('Last-Event-ID'),
    );
    return streamSSE(c, async (stream) => {
      const gone = new AbortController();
      stream.onAbort(() => gone.abort());
      await session.pump(async (frame) => {
        if (gone.signal.aborted) return;
        if ('comment' in frame) {
          await stream.write(`: ${frame.comment}\n\n`);
          return;
        }
        await stream.writeSSE({
          event: frame.event,
          data: JSON.stringify(frame.data),
          ...(frame.id === undefined ? {} : { id: frame.id }),
        });
      }, gone.signal);
    });
  });

  routes.post('/runs/:runId/envelopes/:envelopeId/route', async (c) => {
    const body = (await readJson(c)) as Parameters<DomainService['routeEnvelope']>[2];
    return c.json(
      await domain().routeEnvelope(c.req.param('runId'), c.req.param('envelopeId'), body),
    );
  });

  return routes;
}
