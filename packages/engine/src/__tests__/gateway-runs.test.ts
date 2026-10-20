import type { Event, Model, Provider, Run, RunSummary } from '@ace/contracts';
import { beforeEach, describe, expect, it } from 'vitest';

import { createEngineApp, type EngineApp } from '../gateway/index.js';
import { createEventBus } from '../events/index.js';
import { createGraphService } from '../graph/index.js';
import { createLogger } from '../logging/index.js';
import { LOCAL_SCOPE, type Auth, type EngineEvent, type Scope } from '../ports/index.js';
import { FakeRepository } from './fake-repository.js';
import { InProcessPubSubStub } from './pubsub-stub.js';

const scope = LOCAL_SCOPE;
const NOW = '2026-09-22T10:00:00.000Z';
const TOKEN = 'a'.repeat(64);
const AUTH = { Authorization: `Bearer ${TOKEN}` };
const JSON_HEADERS = { ...AUTH, 'content-type': 'application/json' };
const PROVIDER_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0PRVD';
const RUN_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0RN55';
const WORKFLOW_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0WKFW';
const NODE_RUN_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0NRN5';

const auth: Auth = { verifyToken: async (_s: Scope, token) => token === TOKEN };

const provider = (overrides: Partial<Provider> = {}): Provider => ({
  id: PROVIDER_ID,
  type: 'mock',
  name: 'Mock',
  keySet: false,
  status: 'UNKNOWN',
  concurrency: 20,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const model = (): Model => ({
  id: '01JBXQ8Z9KQ4R7N2VWXYZ0MDE1',
  providerId: PROVIDER_ID,
  modelId: 'mock-text',
  displayName: 'Mock text',
  inputTypes: ['text'],
  outputTypes: ['text'],
  contextWindow: 200_000,
  supportsTools: false,
  supportsJson: false,
  available: true,
  source: 'discovered',
  lastCheckedAt: NOW,
});

const run = (overrides: Partial<Run> = {}): Run => ({
  id: RUN_ID,
  workflowId: WORKFLOW_ID,
  projectId: '01JBXQ8Z9KQ4R7N2VWXYZ0PRJC',
  status: 'COMPLETE',
  snapshot: { version: 1, nodes: [], edges: [] },
  inputs: {},
  preflightIssues: [],
  totals: { tokensIn: 1, tokensOut: 2, costUsd: 0.01 },
  startedAt: NOW,
  endedAt: NOW,
  durationMs: 12,
  ...overrides,
});

/* -------------------------------------------------------------------------- */
/* Harness                                                                     */
/* -------------------------------------------------------------------------- */

interface Calls {
  created: unknown[];
  updated: unknown[];
  removed: { id: string; confirm: boolean }[];
  checked: string[];
  refreshed: string[];
  capabilities: { id: string; modelId: string; patch: unknown }[];
  started: { workflowId: string; request: unknown }[];
}

let app: EngineApp;
let repository: FakeRepository;
let calls: Calls;
let removeResult: { ok: boolean; nodeIds?: string[] };

async function build(): Promise<void> {
  repository = new FakeRepository();
  const pubsub = new InProcessPubSubStub<EngineEvent>();
  const bus = createEventBus({ repository, scope, pubsub, now: () => NOW });
  const logger = createLogger({ level: 'silent', destination: { write: () => undefined } });
  calls = { created: [], updated: [], removed: [], checked: [], refreshed: [], capabilities: [], started: [] };
  removeResult = { ok: true };

  app = createEngineApp({
    repository,
    auth,
    logger,
    scope,
    version: '0.1.0',
    graph: createGraphService({ repository, scope, logger }),
    selfOrigins: ['http://127.0.0.1:4747'],
    providers: {
      create: async (input) => {
        calls.created.push(input);
        return provider({ name: input.name, type: input.type });
      },
      list: async () => [provider()],
      get: async (id) => (id === PROVIDER_ID ? provider() : null),
      update: async (id, patch) => {
        calls.updated.push({ id, patch });
        return id === PROVIDER_ID ? provider({ name: patch.name ?? 'Mock' }) : null;
      },
      remove: async (id, options) => {
        calls.removed.push({ id, confirm: options.confirm });
        // The real service deletes regardless once confirmed (FR-PRV-005).
        return removeResult.ok || options.confirm
          ? { ok: true }
          : { ok: false, reason: 'in_use', nodeIds: removeResult.nodeIds ?? [] };
      },
      check: async (id) => {
        calls.checked.push(id);
        return { status: 'CONNECTED', latencyMs: 4, checkedAt: NOW };
      },
      checkAll: async () => undefined,
      recordStatus: async () => undefined,
      startPeriodicChecks: () => () => undefined,
      refreshModels: async (id) => {
        calls.refreshed.push(id);
        return { models: [model()], refreshedAt: NOW };
      },
      listModels: async (query) => (query.inputType === 'image' ? [] : [model()]),
      setModelCapabilities: async (id, modelId, patch) => {
        calls.capabilities.push({ id, modelId, patch });
        return id === PROVIDER_ID && modelId === 'mock-text'
          ? { ...model(), ...patch, capabilitiesSetByPerson: true }
          : null;
      },
      detect: async () => ({ ollama: { baseUrl: 'http://127.0.0.1:11434', detected: true } }),
      detectClis: async () => ({
        items: [
          {
            type: 'claude_code',
            installed: true,
            version: '2.1.282',
            login: 'logged_in',
            loginDetail: 'claude.ai',
            installHint: 'npm install -g @anthropic-ai/claude-code',
            loginHint: 'claude auth login',
          },
        ],
      }),
      adapterFor: async () => {
        throw new Error('not used');
      },
      semaphoreFor: async () => {
        throw new Error('not used');
      },
    },
    runs: {
      beginRun: async (workflowId, request) => {
        calls.started.push({ workflowId, request });
        // A run that never ends: the route must answer anyway (§5 item 6).
        const { endedAt: _endedAt, durationMs: _durationMs, ...running } = run({ workflowId });
        return { run: { ...running, status: 'RUNNING' }, done: new Promise<Run>(() => undefined) };
      },
      startRun: async () => {
        throw new Error('the gateway must not wait for the end of a run');
      },
      getRun: async () => run(),
      listRuns: async () => ({ items: [summaryOf(run())] }),
      listNodeRuns: async () => [],
      getNodeRun: async () => ({
        id: NODE_RUN_ID,
        runId: RUN_ID,
        nodeId: '01JBXQ8Z9KQ4R7N2VWXYZ0ABCD',
        iteration: 1,
        attempt: 1,
        status: 'COMPLETED',
        inputEnvelopes: [],
        usage: { tokensIn: 1, tokensOut: 2, costUsd: 0 },
        verdicts: [],
        toolCalls: [],
        prompt: { version: 'abc123def456', text: '## System\n...' },
      }),
      // Round 3's three: the gateway never calls them — `RunControls` does — so a stub that throws
      // is the honest fake. A silent one would let a route reach them unnoticed.
      resumeOpenRun: async () => {
        throw new Error('not used');
      },
      driveRecordedRun: async () => {
        throw new Error('the gateway must not drive a recorded run');
      },
      drivePartialRun: async () => {
        throw new Error('the gateway must not drive a partial run');
      },
      envelopesFor: async () => {
        throw new Error('the gateway must not rebuild envelopes');
      },
      shutdown: async () => undefined,
      activeRunCount: () => 0,
    },
    bus,
  });
}

const summaryOf = (source: Run): RunSummary => ({
  id: source.id,
  workflowId: source.workflowId,
  status: source.status,
  startedAt: source.startedAt,
  ...(source.endedAt === undefined ? {} : { endedAt: source.endedAt }),
  ...(source.durationMs === undefined ? {} : { durationMs: source.durationMs }),
  totals: source.totals,
});

const get = (path: string) => app.request(`/api/v1${path}`, { headers: AUTH });
const post = (path: string, body?: unknown) =>
  app.request(`/api/v1${path}`, {
    method: 'POST',
    headers: JSON_HEADERS,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const patch = (path: string, body: unknown) =>
  app.request(`/api/v1${path}`, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(body) });
const del = (path: string) => app.request(`/api/v1${path}`, { method: 'DELETE', headers: AUTH });

const body = async <T>(response: Response): Promise<T> => (await response.json()) as T;

beforeEach(build);

/* -------------------------------------------------------------------------- */
/* Providers                                                                   */
/* -------------------------------------------------------------------------- */

describe('§2.5 provider endpoints', () => {
  it('lists providers', async () => {
    const response = await get('/providers');

    expect(response.status).toBe(200);
    // Every collection answers `{ items }` (D64); `@ace/sdk` parses it with `pageSchema`.
    expect(await body<{ items: Provider[] }>(response)).toEqual({ items: [provider()] });
  });

  it('creates one with 201', async () => {
    const response = await post('/providers', { type: 'mock', name: 'Mock' });

    expect(response.status).toBe(201);
    expect(calls.created[0]).toMatchObject({ type: 'mock', name: 'Mock', concurrency: 20 });
  });

  it('refuses a body the contract does not accept', async () => {
    expect((await post('/providers', { type: 'nope', name: 'x' })).status).toBe(400);
  });

  it('TC-PRV-002 never echoes the key back', async () => {
    const response = await post('/providers', { type: 'openai', name: 'OpenAI', apiKey: 'a-secret' });

    expect(await response.text()).not.toContain('a-secret');
  });

  it('gets one, and 404s for one that is not there', async () => {
    expect((await get(`/providers/${PROVIDER_ID}`)).status).toBe(200);
    expect((await get('/providers/01JBXQ8Z9KQ4R7N2VWXYZ0OTHR')).status).toBe(404);
  });

  it('patches one', async () => {
    const response = await patch(`/providers/${PROVIDER_ID}`, { name: 'Renamed' });

    expect(response.status).toBe(200);
    expect(calls.updated[0]).toMatchObject({ patch: { name: 'Renamed' } });
  });

  it('deletes one with 204', async () => {
    const response = await del(`/providers/${PROVIDER_ID}`);

    expect(response.status).toBe(204);
    expect(calls.removed[0]).toEqual({ id: PROVIDER_ID, confirm: false });
  });

  it('TC-PRV-006 refuses to delete one a node still uses, naming the nodes', async () => {
    removeResult = { ok: false, nodeIds: ['01JBXQ8Z9KQ4R7N2VWXYZ0ABCD'] };

    const response = await del(`/providers/${PROVIDER_ID}`);

    expect(response.status).toBe(409);
    const payload = await body<{ error: { code: string; details: { nodeIds: string[] } } }>(response);
    expect(payload.error.code).toBe('provider_in_use');
    expect(payload.error.details.nodeIds).toEqual(['01JBXQ8Z9KQ4R7N2VWXYZ0ABCD']);
  });

  it('deletes it anyway with ?confirm=true', async () => {
    removeResult = { ok: false, nodeIds: ['01JBXQ8Z9KQ4R7N2VWXYZ0ABCD'] };

    const response = await del(`/providers/${PROVIDER_ID}?confirm=true`);

    expect(calls.removed[0]).toEqual({ id: PROVIDER_ID, confirm: true });
    expect(response.status).toBe(204);
  });

  it('TC-PRV-003 checks one', async () => {
    const response = await post(`/providers/${PROVIDER_ID}/check`);

    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({ status: 'CONNECTED', latencyMs: 4, checkedAt: NOW });
  });

  it('FR-MOD-006 refreshes its models', async () => {
    const response = await post(`/providers/${PROVIDER_ID}/refresh-models`);

    expect(response.status).toBe(200);
    expect(await body<{ models: Model[]; refreshedAt: string }>(response)).toEqual({
      models: [model()],
      refreshedAt: NOW,
    });
  });

  it('D380 PATCH marks a model as tool-capable and answers the updated model', async () => {
    const response = await patch(`/providers/${PROVIDER_ID}/models/mock-text`, {
      supportsTools: true,
    });

    expect(response.status).toBe(200);
    expect(await body<Model>(response)).toMatchObject({
      modelId: 'mock-text',
      supportsTools: true,
      capabilitiesSetByPerson: true,
    });
    expect(calls.capabilities[0]).toEqual({
      id: PROVIDER_ID,
      modelId: 'mock-text',
      patch: { supportsTools: true },
    });
  });

  it('D380 PATCH answers 404 for a model the provider does not list', async () => {
    const response = await patch(`/providers/${PROVIDER_ID}/models/nope`, { supportsTools: true });

    expect(response.status).toBe(404);
  });

  it('D380 PATCH reaches a model id that contains a slash or colon', async () => {
    await patch(`/providers/${PROVIDER_ID}/models/${encodeURIComponent('models/gemini:3')}`, {
      contextWindow: 65_536,
    });

    expect(calls.capabilities[0]).toMatchObject({ modelId: 'models/gemini:3' });
  });

  it('D380 PATCH refuses an unknown field and an out-of-range window', async () => {
    const extra = await patch(`/providers/${PROVIDER_ID}/models/mock-text`, { name: 'x' });
    const small = await patch(`/providers/${PROVIDER_ID}/models/mock-text`, { contextWindow: 10 });

    expect(extra.status).toBe(400);
    expect(small.status).toBe(400);
    expect(calls.capabilities).toEqual([]);
  });

  it('FR-PRV-007 answers the detection probe, and does not read it as a provider id', async () => {
    const response = await get('/providers/detect');

    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({
      ollama: { baseUrl: 'http://127.0.0.1:11434', detected: true },
    });
  });
});

describe('TC-MOD-003 the catalog endpoint', () => {
  it('lists the catalog with its refresh time', async () => {
    const response = await get('/models');

    expect(response.status).toBe(200);
    const payload = await body<{ items: Model[]; refreshedAt: string }>(response);
    expect(payload.items).toEqual([model()]);
    expect(payload.refreshedAt).toBeTruthy();
  });

  it('passes the filters through', async () => {
    const payload = await body<{ items: Model[] }>(await get('/models?inputType=image'));

    expect(payload.items).toEqual([]);
  });

  it('refuses a filter the contract does not define', async () => {
    expect((await get('/models?inputType=hologram')).status).toBe(400);
  });
});

/* -------------------------------------------------------------------------- */
/* Runs                                                                        */
/* -------------------------------------------------------------------------- */

describe('§2.5 run endpoints', () => {
  it('FR-EXE-001 starts a run with 201', async () => {
    const response = await post(`/workflows/${WORKFLOW_ID}/runs`, {});

    expect(response.status).toBe(201);
    expect(calls.started[0]?.workflowId).toBe(WORKFLOW_ID);
  });

  it('FR-EXE-008 answers while the run is still going, so the client can watch it (D65)', async () => {
    const response = await post(`/workflows/${WORKFLOW_ID}/runs`, {});

    expect(response.status).toBe(201);
    const started = await body<Run>(response);
    expect(started.status).toBe('RUNNING');
    expect(started.endedAt).toBeUndefined();
  });

  it('FR-NODE-011 passes the inputs the dialog collected', async () => {
    await post(`/workflows/${WORKFLOW_ID}/runs`, {
      inputs: { '01JBXQ8Z9KQ4R7N2VWXYZ0ABCD': [{ type: 'text', text: 'typed' }] },
    });

    expect(calls.started[0]?.request).toMatchObject({
      inputs: { '01JBXQ8Z9KQ4R7N2VWXYZ0ABCD': [{ type: 'text', text: 'typed' }] },
    });
  });

  it('starts a run with no body at all', async () => {
    expect((await post(`/workflows/${WORKFLOW_ID}/runs`)).status).toBe(201);
  });

  it('FR-EXE-003 answers 201 even for a run pre-flight blocked — it is still a run', async () => {
    const response = await post(`/workflows/${WORKFLOW_ID}/runs`, {});

    expect(response.status).toBe(201);
  });

  it('TC-EXE-011 lists the run history', async () => {
    const response = await get(`/workflows/${WORKFLOW_ID}/runs`);

    expect(response.status).toBe(200);
    const payload = await body<{ items: RunSummary[] }>(response);
    expect(payload.items[0]?.id).toBe(RUN_ID);
  });

  it('gets one run', async () => {
    expect((await body<Run>(await get(`/runs/${RUN_ID}`))).id).toBe(RUN_ID);
  });

  it('lists the node runs of a run', async () => {
    expect((await get(`/runs/${RUN_ID}/node-runs`)).status).toBe(200);
  });

  it('TC-PRM-005 gets one node run, with the exact prompt on it', async () => {
    const response = await get(`/node-runs/${NODE_RUN_ID}`);

    expect(response.status).toBe(200);
    const payload = await body<{ prompt: { version: string; text: string } }>(response);
    expect(payload.prompt.version).toBe('abc123def456');
    expect(payload.prompt.text).toContain('## System');
  });
});

describe('TC-EXE-013 the events endpoint replays what a client missed', () => {
  beforeEach(async () => {
    const pubsub = new InProcessPubSubStub<EngineEvent>();
    const bus = createEventBus({ repository, scope, pubsub, now: () => NOW });
    for (const status of ['READY', 'RUNNING', 'COMPLETED']) {
      await bus.emit({
        type: 'node.state',
        workflowId: WORKFLOW_ID,
        runId: RUN_ID,
        payload: { status },
      });
    }
  });

  it('returns every event of the run, in seq order', async () => {
    const events = await body<Event[]>(await get(`/runs/${RUN_ID}/events`));

    expect(events.map((event) => (event.payload as { status: string }).status)).toEqual([
      'READY',
      'RUNNING',
      'COMPLETED',
    ]);
    expect(events.map((event) => event.seq)).toEqual([...events.map((e) => e.seq)].sort((a, b) => a - b));
  });

  it('returns only what came after the sequence the client has', async () => {
    const all = await body<Event[]>(await get(`/runs/${RUN_ID}/events`));
    const after = await body<Event[]>(await get(`/runs/${RUN_ID}/events?afterSeq=${all[0]!.seq}`));

    expect(after).toHaveLength(2);
    expect(after[0]?.seq).toBeGreaterThan(all[0]!.seq);
  });

  it('never returns another run events', async () => {
    const events = await body<Event[]>(await get('/runs/01JBXQ8Z9KQ4R7N2VWXYZ0OTHR/events'));

    expect(events).toEqual([]);
  });

  it('refuses a negative afterSeq', async () => {
    expect((await get(`/runs/${RUN_ID}/events?afterSeq=-1`)).status).toBe(400);
  });
});

describe('FR-SYS-002 every round 2 route needs the session token', () => {
  it.each([
    '/providers',
    '/providers/detect',
    '/models',
    `/runs/${RUN_ID}`,
    `/runs/${RUN_ID}/node-runs`,
    `/runs/${RUN_ID}/events`,
    `/node-runs/${NODE_RUN_ID}`,
    `/workflows/${WORKFLOW_ID}/runs`,
  ])('401s %s without one', async (path) => {
    expect((await app.request(`/api/v1${path}`)).status).toBe(401);
  });
});

describe('FR-PRV-008 the terminal scan route (X1)', () => {
  it('answers the scan, and does not read "detect" as a provider id', async () => {
    const response = await get('/providers/detect/clis');
    expect(response.status).toBe(200);
    expect(await body(response)).toMatchObject({
      items: [{ type: 'claude_code', installed: true }],
    });
  });

  it('needs the session token', async () => {
    expect((await app.request('/api/v1/providers/detect/clis')).status).toBe(401);
  });

  it('refuses a permission level on a provider that is not a CLI', async () => {
    const response = await patch(`/providers/${PROVIDER_ID}`, { cliPermission: 'full_auto' });
    expect(response.status).toBe(400);
  });
});
