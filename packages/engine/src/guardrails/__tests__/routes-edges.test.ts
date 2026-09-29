import { API_BASE_PATH, type ApiError } from '@ace/contracts';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { toApiError } from '../../gateway/errors.js';
import type { PolicyService } from '../policy-service.js';
import { createGuardrailRoutes } from '../routes.js';
import { id } from './fakes.js';

/**
 * Two guardrail-route branches the happy-path suite skips: the app built without a policy service
 * answers 501, and a service error that is neither "policy not found" nor "project not found" falls
 * through the `answering` wrapper to `toApiError` (which answers it 500), rather than being masked.
 */
function appWith(service: PolicyService | undefined): Hono {
  const app = new Hono();
  app.onError((error, c) => {
    const { status, body } = toApiError(error);
    return c.json(body, status as 400);
  });
  app.route(API_BASE_PATH, createGuardrailRoutes(service));
  return app;
}

const request = async (app: Hono, method: string, path: string): Promise<Response> =>
  app.request(`http://127.0.0.1:4747${API_BASE_PATH}${path}`, { method });

describe('guardrail routes — service absent and unexpected errors', () => {
  it('answers 501 not_implemented when no policy service was wired', async () => {
    const app = appWith(undefined);

    const response = await request(app, 'GET', '/guardrail-policies?projectId=' + id());

    expect(response.status).toBe(501);
    expect((await response.json()) as ApiError).toMatchObject({
      error: { code: 'not_implemented' },
    });
  });

  it('lets an unexpected service error fall through to a 500', async () => {
    const service = {
      get: async () => {
        throw new Error('the database is down');
      },
    } as unknown as PolicyService;
    const app = appWith(service);

    const response = await request(app, 'GET', `/guardrail-policies/${id()}`);

    expect(response.status).toBe(500);
  });
});
