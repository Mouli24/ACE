import { API_BASE_PATH } from '@ace/contracts';
import { Hono } from 'hono';

import { toApiError } from '../gateway/errors.js';

/**
 * A sub-router mounted the way the gateway mounts it — under `/api/v1`, behind the `onError` that
 * turns a thrown `HttpError` or `ZodError` into the §2.3 envelope — without the auth and origin
 * guards, which the gateway's own tests cover. For the round 5 route tests (Task 13b).
 */
export function routeApp(router: Hono<{ Variables: { requestId: string } }>): Hono {
  const app = new Hono();
  app.onError((error, c) => {
    const { status, body } = toApiError(error);
    return c.json(body, status as 400);
  });
  const api = new Hono<{ Variables: { requestId: string } }>();
  api.route('/', router);
  app.route(API_BASE_PATH, api);
  return app;
}

/** A JSON request (or none) to `/api/v1<path>`. */
export async function send(
  app: Hono,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return await app.request(`http://127.0.0.1:4747${API_BASE_PATH}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          body: typeof body === 'string' ? body : JSON.stringify(body),
          headers: { 'content-type': 'application/json' },
        }),
  });
}

/** The §2.3 envelope's `code`, for a refusal. */
export async function errorCode(response: Response): Promise<string> {
  return ((await response.json()) as { error: { code: string } }).error.code;
}
