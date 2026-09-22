import { ApiErrorSchema, type Project, type WorkflowGraphResponse } from '@ace/contracts';

import { AceApiError, createAceClient } from '../index.js';

const ID_A = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const ID_B = '01ARZ3NDEKTSV4RRFFQ69G5FAW';
const NOW = '2026-09-22T00:00:00.000Z';

const project: Project = {
  id: ID_A,
  name: 'Demo',
  folderPath: '/tmp/demo',
  createdAt: NOW,
  updatedAt: NOW,
};

interface Call {
  url: string;
  init: RequestInit;
}

/** A fetch double that records calls and answers with a queue of responses. */
function fakeFetch(responses: Array<{ status: number; body?: unknown }>) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error('no response queued');
    if (next.status === 204) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchImpl, calls };
}

const make = (fetchImpl: typeof fetch, baseUrl = 'http://x') =>
  createAceClient({ baseUrl, token: 't', fetch: fetchImpl });

describe('createAceClient (round 1 §2.8, FR-SYS-002)', () => {
  it('sends the bearer token on every request and parses the health body', async () => {
    const { fetchImpl, calls } = fakeFetch([
      { status: 200, body: { status: 'ok', version: '0.0.0', db: 'ok' } },
    ]);
    const client = createAceClient({
      baseUrl: 'http://127.0.0.1:4747',
      token: 'tok',
      fetch: fetchImpl,
    });

    const health = await client.health();

    expect(health).toEqual({ status: 'ok', version: '0.0.0', db: 'ok' });
    expect(calls[0]?.url).toBe('http://127.0.0.1:4747/api/v1/health');
    expect(new Headers(calls[0]?.init.headers).get('authorization')).toBe('Bearer tok');
  });

  it('tolerates a baseUrl that already ends in a slash', async () => {
    const { fetchImpl, calls } = fakeFetch([{ status: 200, body: { items: [] } }]);
    await make(fetchImpl, 'http://127.0.0.1:4747/').listProjects();
    expect(calls[0]?.url).toBe('http://127.0.0.1:4747/api/v1/projects');
  });

  it('POST /projects sends the body and parses the Project', async () => {
    const { fetchImpl, calls } = fakeFetch([{ status: 201, body: project }]);
    const created = await make(fetchImpl).createProject({ name: 'Demo', folderPath: '/tmp/demo' });
    expect(created).toEqual(project);
    expect(calls[0]?.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      name: 'Demo',
      folderPath: '/tmp/demo',
    });
  });

  it('list endpoints pass cursor and limit as query params and parse the page', async () => {
    const { fetchImpl, calls } = fakeFetch([
      { status: 200, body: { items: [project], nextCursor: 'abc' } },
    ]);
    const page = await make(fetchImpl).listProjects({ cursor: 'c1', limit: 10 });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBe('abc');
    expect(calls[0]?.url).toBe('http://x/api/v1/projects?cursor=c1&limit=10');
  });

  it('DELETE returns void on 204', async () => {
    const { fetchImpl, calls } = fakeFetch([{ status: 204 }]);
    await expect(make(fetchImpl).deleteProject(ID_A)).resolves.toBeUndefined();
    expect(calls[0]?.init.method).toBe('DELETE');
    expect(calls[0]?.url).toBe(`http://x/api/v1/projects/${ID_A}`);
  });

  it('every other §2.8 endpoint hits its path with its method', async () => {
    const wf = {
      id: ID_B,
      projectId: ID_A,
      name: 'Flow',
      version: 0,
      formatVersion: 1 as const,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const graph: WorkflowGraphResponse = { workflow: wf, nodes: [], edges: [] };
    const settings = {
      dataDir: '/d',
      concurrency: 20,
      theme: 'dark',
      onboardingCompleted: false,
      allowedOrigins: [],
    };
    const { fetchImpl, calls } = fakeFetch([
      { status: 200, body: settings },
      { status: 200, body: settings },
      { status: 200, body: project },
      { status: 200, body: project },
      { status: 200, body: project },
      { status: 200, body: { items: [wf] } },
      { status: 200, body: wf },
      { status: 200, body: graph },
      { status: 200, body: wf },
      { status: 204 },
      { status: 200, body: graph },
      { status: 200, body: { version: 1, nodes: [], edges: [] } },
      { status: 200, body: { issues: [] } },
      {
        status: 200,
        body: { formatVersion: 1, exportedAt: NOW, name: 'Flow', nodes: [], edges: [] },
      },
      { status: 200, body: graph },
    ]);
    const c = make(fetchImpl);

    await c.getSettings();
    await c.patchSettings({ theme: 'light' });
    await c.getProject(ID_A);
    await c.updateProject(ID_A, { name: 'Demo 2' });
    await c.openProject(ID_A);
    await c.listWorkflows(ID_A);
    await c.createWorkflow(ID_A, { name: 'Flow' });
    await c.getWorkflow(ID_B);
    await c.updateWorkflow(ID_B, { name: 'Flow 2' });
    await c.deleteWorkflow(ID_B);
    await c.duplicateWorkflow(ID_B);
    await c.applyGraphOps(ID_B, { baseVersion: 0, ops: [{ op: 'delete_node', nodeId: ID_A }] });
    await c.validateWorkflow(ID_B);
    const exported = await c.exportWorkflow(ID_B);
    await c.importWorkflow(ID_A, exported);

    expect(
      calls.map((x) => `${x.init.method ?? 'GET'} ${x.url.replace('http://x/api/v1', '')}`),
    ).toEqual([
      'GET /settings',
      'PATCH /settings',
      `GET /projects/${ID_A}`,
      `PATCH /projects/${ID_A}`,
      `POST /projects/${ID_A}/open`,
      `GET /projects/${ID_A}/workflows`,
      `POST /projects/${ID_A}/workflows`,
      `GET /workflows/${ID_B}`,
      `PATCH /workflows/${ID_B}`,
      `DELETE /workflows/${ID_B}`,
      `POST /workflows/${ID_B}/duplicate`,
      `POST /workflows/${ID_B}/graph-ops`,
      `POST /workflows/${ID_B}/validate`,
      `GET /workflows/${ID_B}/export`,
      `POST /projects/${ID_A}/workflows/import`,
    ]);
  });

  it('rejects a response that does not match the contract schema', async () => {
    const { fetchImpl } = fakeFetch([{ status: 200, body: { nope: true } }]);
    await expect(make(fetchImpl).getProject(ID_A)).rejects.toMatchObject({
      name: 'AceApiError',
      code: 'invalid_response',
    });
  });

  it('rejects a request body that violates the contract before sending anything', async () => {
    const { fetchImpl, calls } = fakeFetch([]);
    await expect(make(fetchImpl).createProject({ name: '' })).rejects.toMatchObject({
      code: 'validation_failed',
      kind: 'invalid_config',
    });
    expect(calls).toHaveLength(0);
  });
});

describe('AceApiError (FR-SYS-006 error envelope)', () => {
  it('wraps a 409 stale_version response with status, kind, code, details, retryable', async () => {
    const body = {
      error: {
        kind: 'workflow',
        code: 'stale_version',
        message: 'stale',
        details: { currentVersion: 4 },
        retryable: false,
      },
    };
    expect(ApiErrorSchema.safeParse(body).success).toBe(true);
    const { fetchImpl } = fakeFetch([{ status: 409, body }]);

    const err = await make(fetchImpl)
      .applyGraphOps(ID_B, { baseVersion: 0, ops: [{ op: 'delete_node', nodeId: ID_A }] })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AceApiError);
    const apiErr = err as AceApiError;
    expect(apiErr.status).toBe(409);
    expect(apiErr.kind).toBe('workflow');
    expect(apiErr.code).toBe('stale_version');
    expect(apiErr.details).toEqual({ currentVersion: 4 });
    expect(apiErr.retryable).toBe(false);
    expect(apiErr.message).toBe('stale');
    expect(apiErr.toApiError()).toEqual(body);
  });

  it('wraps a non-JSON error response as an internal error carrying the HTTP status', async () => {
    const fetchImpl: typeof fetch = async () => new Response('<html>oops</html>', { status: 502 });
    const err = (await make(fetchImpl)
      .health()
      .catch((e: unknown) => e)) as AceApiError;
    expect(err).toBeInstanceOf(AceApiError);
    expect(err.status).toBe(502);
    expect(err.code).toBe('internal');
  });

  it('wraps a thrown fetch as a retryable network error with status 0', async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new TypeError('Failed to fetch');
    };
    const err = (await make(fetchImpl)
      .health()
      .catch((e: unknown) => e)) as AceApiError;
    expect(err).toBeInstanceOf(AceApiError);
    expect(err.kind).toBe('network');
    expect(err.retryable).toBe(true);
    expect(err.status).toBe(0);
  });

  it('AceApiError.is narrows unknown values', () => {
    expect(AceApiError.is(new Error('x'))).toBe(false);
    expect(
      AceApiError.is(
        new AceApiError(404, {
          kind: 'workflow',
          code: 'not_found',
          message: 'nf',
          retryable: false,
        }),
      ),
    ).toBe(true);
  });
});
