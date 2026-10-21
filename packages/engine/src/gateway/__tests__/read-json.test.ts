import {
  API_BASE_PATH,
  ApiErrorSchema,
  type GuardrailPolicy,
  type NodeRun,
  type Project,
} from '@ace/contracts';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { FakeRepository } from '../../__tests__/fake-repository.js';
import { createApprovalService } from '../../approvals/index.js';
import { createApprovalRoutes } from '../../approvals/routes.js';
import { createGraphService } from '../../graph/index.js';
import { createPolicyService } from '../../guardrails/policy-service.js';
import { createGuardrailRoutes } from '../../guardrails/routes.js';
import {
  FakeGuardrailStore,
  RecordingBus,
  fakeChecks,
  id,
  project,
} from '../../guardrails/__tests__/fakes.js';
import { createLogger } from '../../logging/index.js';
import { LOCAL_SCOPE, type Auth, type Scope } from '../../ports/index.js';
import { createRunControlRoutes } from '../../runs/control/routes.js';
import type { RunControls } from '../../runs/control/service.js';
import { toApiError } from '../errors.js';
import { createEngineApp, readJson } from '../index.js';

/**
 * FR-SYS-006, §2.3: a body that is not JSON is refused, never read as an empty one.
 *
 * Every field of a PATCH is optional, so a truncated body read as `{}` answered 200 and changed
 * nothing — the client believed the cost cap was set while runs went uncapped, a policy edit
 * wrote a spurious version, and an approval was recorded without its note. An empty body still
 * reads as `{}`: starting a run or re-running a node needs none.
 */

const TOKEN = 'a'.repeat(64);
const AUTH = { Authorization: `Bearer ${TOKEN}` };
const auth: Auth = {
  verifyToken: async (_scope: Scope, token: string | undefined) => token === TOKEN,
};

const TRUNCATED_CAP = '{"maxCostPerRunUsd": 0.01';

const url = (path: string): string => `http://127.0.0.1:4747${API_BASE_PATH}${path}`;

const raw = (method: string, body: string): RequestInit => ({
  method,
  body,
  headers: { ...AUTH, 'content-type': 'application/json' },
});

/** An app with the gateway's own `onError`, so a thrown refusal becomes the §2.3 envelope. */
function withErrors(mount: (api: Hono) => void): Hono {
  const app = new Hono();
  app.onError((error, c) => {
    const { status, body } = toApiError(error);
    return c.json(body, status as 400);
  });
  const api = new Hono();
  mount(api);
  app.route(API_BASE_PATH, api);
  return app;
}

async function expectInvalidJson(response: Response): Promise<void> {
  expect(response.status).toBe(400);
  const { error } = ApiErrorSchema.parse(await response.json());
  expect(error.code).toBe('validation_failed');
  expect(error.message).toContain('not valid JSON');
}

describe('FR-SYS-006 readJson reads a body, and refuses one that is not JSON', () => {
  const echo = withErrors((api) => {
    api.post('/echo', async (c) => c.json({ body: await readJson(c) }));
  });
  const post = async (body?: string): Promise<Response> =>
    echo.request(url('/echo'), {
      method: 'POST',
      ...(body === undefined ? {} : { body }),
    });

  it('reads no body at all, or only whitespace, as {}', async () => {
    for (const body of [undefined, '', '  \n\t ']) {
      const response = await post(body);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ body: {} });
    }
  });

  it('parses a JSON body as it is', async () => {
    const response = await post('{"note":"ok","n":[1,2]}');

    expect(await response.json()).toEqual({ body: { note: 'ok', n: [1, 2] } });
  });

  it.each([
    ['a truncated object', TRUNCATED_CAP],
    ['plain text', 'not json at all'],
    ['a trailing comma', '{"name":"A",}'],
  ])('answers 400 validation_failed for %s', async (_label, body) => {
    await expectInvalidJson(await post(body));
  });
});

describe('FR-SYS-006 PATCH /projects/:id with a truncated body', () => {
  it('answers 400 and leaves the cost cap unset, instead of a 200 that changed nothing', async () => {
    const repository = new FakeRepository();
    const logger = createLogger({
      level: 'silent',
      destination: { write: () => undefined },
    });
    const app = createEngineApp({
      repository,
      auth,
      logger,
      scope: LOCAL_SCOPE,
      version: '0.1.0',
      graph: createGraphService({ repository, scope: LOCAL_SCOPE, logger }),
      selfOrigins: ['http://127.0.0.1:4747'],
    });
    const projectId = '01JBXQ8Z9KQ4R7N2VWXYZ0PRJC';
    await repository.projects.create(LOCAL_SCOPE, {
      id: projectId,
      name: 'Demo',
      folderPath: 'D:/projects/demo',
      createdAt: '2026-09-26T10:00:00.000Z',
      updatedAt: '2026-09-26T10:00:00.000Z',
    });

    await expectInvalidJson(
      await app.request(`/api/v1/projects/${projectId}`, raw('PATCH', TRUNCATED_CAP)),
    );

    const read = await app.request(`/api/v1/projects/${projectId}`, {
      headers: AUTH,
    });
    expect(((await read.json()) as Project).maxCostPerRunUsd).toBeUndefined();
  });
});

describe('FR-SYS-006 PATCH /guardrail-policies/:id with a truncated body', () => {
  it('answers 400 and writes no new version', async () => {
    const store = new FakeGuardrailStore();
    const owner = project();
    store.projectRows.set(owner.id, owner);
    const policies = createPolicyService({
      scope: LOCAL_SCOPE,
      policies: store.policies,
      projects: store.projects,
      policyUsage: store.policyUsage,
      checks: fakeChecks,
    });
    const app = withErrors((api) => api.route('/', createGuardrailRoutes(policies)));
    const created = (await (
      await app.request(url('/guardrail-policies'), {
        method: 'POST',
        body: JSON.stringify({
          projectId: owner.id,
          name: 'Strict',
          checks: [],
        }),
        headers: { 'content-type': 'application/json' },
      })
    ).json()) as GuardrailPolicy;

    await expectInvalidJson(
      await app.request(url(`/guardrail-policies/${created.id}`), raw('PATCH', '{"name": "Lax"')),
    );

    const read = (await (
      await app.request(url(`/guardrail-policies/${created.id}`))
    ).json()) as GuardrailPolicy;
    expect(read).toMatchObject({ version: 1, name: 'Strict' });
  });
});

describe('FR-SYS-006 POST /node-runs/:id/approve with a truncated body', () => {
  it('answers 400 and leaves the approval pending, rather than recording it without its note', async () => {
    const store = new FakeGuardrailStore();
    const approvals = createApprovalService({
      scope: LOCAL_SCOPE,
      approvals: store.approvals,
      nodeRuns: store.nodeRuns,
      bus: new RecordingBus(),
    });
    const app = withErrors((api) => api.route('/', createApprovalRoutes(approvals)));
    const runId = id();
    const nodeRunId = id();
    const nodeRun: NodeRun = {
      id: nodeRunId,
      runId,
      nodeId: id(),
      iteration: 1,
      attempt: 1,
      status: 'WAITING',
      inputEnvelopes: [],
      usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
      verdicts: [],
      toolCalls: [],
    };
    store.nodeRunRows.set(nodeRunId, nodeRun);
    let decided = false;
    const pending = approvals.request({
      runId,
      workflowId: id(),
      nodeRunId,
      nodeId: nodeRun.nodeId,
      nodeName: 'Writer',
      point: 'output',
      checkType: 'pii',
      reason: 'Personal data found: email.',
      preview: 'nobody@example.com',
    });
    void pending.then(() => {
      decided = true;
    });

    await expectInvalidJson(
      await app.request(
        url(`/node-runs/${nodeRunId}/approve`),
        raw('POST', '{"note":"checked with legal, fine to send'),
      ),
    );

    const listed = (await (await app.request(url(`/runs/${runId}/approvals`))).json()) as unknown[];
    expect(listed).toHaveLength(1);
    expect(decided).toBe(false);

    // The same decision, sent whole, is recorded with its note.
    const approved = await app.request(
      url(`/node-runs/${nodeRunId}/approve`),
      raw('POST', '{"note":"checked with legal, fine to send"}'),
    );
    expect(approved.status).toBe(200);
    expect((await pending).note).toBe('checked with legal, fine to send');
  });
});

describe('FR-SYS-006 the run control routes read a body the same way', () => {
  function controlsApp(): { app: Hono; reruns: string[] } {
    const reruns: string[] = [];
    const unused = async (): Promise<never> => {
      throw new Error('not under test');
    };
    const controls: RunControls = {
      pause: unused,
      resume: unused,
      stop: unused,
      restart: unused,
      get: unused,
      retryNodeRun: unused,
      continueRun: unused,
      rerunNode: async (runId, nodeId) => {
        reruns.push(`${runId}/${nodeId}`);
        return { id: id() } as NodeRun;
      },
    };
    return {
      app: withErrors((api) =>
        api.route(
          '/',
          createRunControlRoutes(() => controls),
        ),
      ),
      reruns,
    };
  }

  it('re-runs a node on an empty body, as before', async () => {
    const { app, reruns } = controlsApp();

    const response = await app.request(url('/runs/r1/nodes/n1/rerun'), {
      method: 'POST',
    });

    expect(response.status).toBe(201);
    expect(reruns).toEqual(['r1/n1']);
  });

  it('answers 400 for a rerun or a retry whose body is not JSON, and runs nothing', async () => {
    const { app, reruns } = controlsApp();

    await expectInvalidJson(await app.request(url('/runs/r1/nodes/n1/rerun'), raw('POST', '{')));
    await expectInvalidJson(
      await app.request(url('/node-runs/nr1/retry'), raw('POST', '{"withDownstream": true')),
    );
    expect(reruns).toEqual([]);
  });
});
