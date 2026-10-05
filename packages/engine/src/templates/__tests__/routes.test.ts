import {
  InstantiateTemplateResponseSchema,
  TEMPLATE_IDS,
  TemplateSchema,
  type InstantiateTemplateRequest,
  type InstantiateTemplateResponse,
  type TemplateId,
} from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { errorCode, routeApp, send } from '../../__tests__/route-app.js';
import { createTemplateRoutes } from '../routes.js';
import { TEMPLATE_DEFINITIONS, type TemplateService } from '../service.js';

/**
 * The template routes of round 5 §2.7 / §2.9 (FR-ONB-002): a bare `Template[]`; instantiate at 201
 * with the contract's body (both names → 400), an id that is no template 404 before anything runs,
 * and 501 without the service (D121). The service itself is `templates.test.ts`'s.
 */

const AT = '2026-10-05T09:00:00.000Z';
const PROJECT = '01JBXQ8Z9KQ4R7N2VWXYZ0PRJC';
const WORKFLOW = '01JBXQ8Z9KQ4R7N2VWXYZ0WFX1';

/** A service that answers a fixed instantiation and records what it was asked. */
function recordingService(): TemplateService & {
  calls: [TemplateId, InstantiateTemplateRequest][];
} {
  const calls: [TemplateId, InstantiateTemplateRequest][] = [];
  return {
    calls,
    list: () => TEMPLATE_DEFINITIONS.map((template) => ({ ...template })),
    async instantiate(id, body): Promise<InstantiateTemplateResponse> {
      calls.push([id, body]);
      return {
        project: {
          id: PROJECT,
          name: body.projectName ?? 'Linear chain',
          folderPath: '',
          createdAt: AT,
          updatedAt: AT,
        },
        workflow: {
          id: WORKFLOW,
          projectId: PROJECT,
          name: 'Linear chain',
          version: 1,
          formatVersion: 1,
          createdAt: AT,
          updatedAt: AT,
        },
        nodes: [],
        edges: [],
      };
    },
  };
}

describe('FR-ONB-002 GET /templates', () => {
  it('lists the four templates as a bare array, in wizard order', async () => {
    const app = routeApp(createTemplateRoutes(recordingService()));

    const response = await send(app, 'GET', '/templates');

    expect(response.status).toBe(200);
    expect(
      TemplateSchema.array()
        .parse(await response.json())
        .map((t) => t.id),
    ).toEqual([...TEMPLATE_IDS]);
  });
});

describe('FR-ONB-002 POST /templates/:id/instantiate', () => {
  it('answers 201 with the instantiation, passing the parsed body on', async () => {
    const service = recordingService();
    const app = routeApp(createTemplateRoutes(service));

    const response = await send(app, 'POST', '/templates/linear-chain/instantiate', {
      projectName: 'Mine',
    });

    expect(response.status).toBe(201);
    expect(InstantiateTemplateResponseSchema.parse(await response.json()).project.name).toBe(
      'Mine',
    );
    expect(service.calls).toEqual([['linear-chain', { projectName: 'Mine' }]]);
  });

  it('takes an empty body as neither name — a new project named after the template', async () => {
    const service = recordingService();
    const app = routeApp(createTemplateRoutes(service));

    const response = await send(app, 'POST', '/templates/rag-qa/instantiate');

    expect(response.status).toBe(201);
    expect(service.calls).toEqual([['rag-qa', {}]]);
  });

  it('refuses both names, an unknown key and a bad id with 400, and calls nothing', async () => {
    const service = recordingService();
    const app = routeApp(createTemplateRoutes(service));

    for (const body of [
      { projectId: PROJECT, projectName: 'Both' },
      { project: 'x' },
      { projectId: 'not-an-id' },
      '{"projectName":',
    ]) {
      const response = await send(app, 'POST', '/templates/linear-chain/instantiate', body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await errorCode(response)).toBe('validation_failed');
    }
    expect(service.calls).toEqual([]);
  });

  it('an id that is no template is 404, whatever the body', async () => {
    const service = recordingService();
    const app = routeApp(createTemplateRoutes(service));

    const response = await send(app, 'POST', '/templates/kanban/instantiate', { projectName: 'x' });

    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe('not_found');
    expect(service.calls).toEqual([]);
  });

  it('D121 answers 501 on both routes without the service', async () => {
    const app = routeApp(createTemplateRoutes(undefined));
    for (const [method, path] of [
      ['GET', '/templates'],
      ['POST', '/templates/linear-chain/instantiate'],
    ] as const) {
      const response = await send(app, method, path);
      expect(response.status, path).toBe(501);
      expect(await errorCode(response)).toBe('not_implemented');
    }
  });
});
