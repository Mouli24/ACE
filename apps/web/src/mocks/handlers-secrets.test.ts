import { createAceClient, type AceApiError } from '@ace/sdk';
import { setupServer } from 'msw/node';

import { MockDb } from './db';
import { createHandlers } from './handlers';
import { createRound2Handlers } from './handlers-round2';
import { createRound3Handlers } from './handlers-round3';
import { createSecretHandlers } from './handlers-secrets';
import { createTaskHandlers } from './handlers-tasks';
import { seedPendingApproval } from './inbox-seed';
import { mockSecretValue, resetMockSecrets } from './secrets';
import { createTask, resetMockTasks } from './tasks';

/**
 * The ACE parity P1 MSW seam (D274, D270): the mock secrets and approvals inbox answered through
 * the real SDK, so every reply is parsed with the contract the engine must also satisfy — and a
 * secret's value, kept in the mock keychain, is never in any reply.
 */

const VALUE = 'fake-mock-value-0001';

const db = new MockDb({ persist: false });
const server = setupServer(
  ...createSecretHandlers(db),
  ...createTaskHandlers(db),
  ...createRound3Handlers(db),
  ...createRound2Handlers(db),
  ...createHandlers(db),
);
const client = createAceClient({
  baseUrl: 'http://mock.local',
  token: 'mock',
  fetch: (input, init) => globalThis.fetch(input, init),
});

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());
beforeEach(() => {
  resetMockSecrets();
  resetMockTasks();
  db.reset();
});

async function failure(promise: Promise<unknown>): Promise<AceApiError> {
  try {
    await promise;
  } catch (error) {
    return error as AceApiError;
  }
  throw new Error('expected the call to fail');
}

/** Every reply, as text, so a test can say a value is in none of them. */
async function rawGet(path: string): Promise<string> {
  const response = await fetch(`http://mock.local/api/v1${path}`, {
    headers: { authorization: 'Bearer mock' },
  });
  return response.text();
}

describe('D274 mock /secrets', () => {
  it('creates, lists, replaces and deletes, keeping the value in the mock keychain only', async () => {
    const project = db.createProject({ name: 'Shop' });
    const created = await client.createSecret({
      name: 'DEPLOY_TOKEN',
      value: VALUE,
      description: 'Staging',
      projectIds: [project.id, project.id],
    });
    expect(created).toMatchObject({ name: 'DEPLOY_TOKEN', projectIds: [project.id] });
    expect(mockSecretValue('DEPLOY_TOKEN')).toBe(VALUE);
    expect(JSON.stringify(created)).not.toContain(VALUE);
    expect(await rawGet('/secrets')).not.toContain(VALUE);
    expect((await client.listSecrets()).items).toEqual([created]);

    const replaced = await client.updateSecret('DEPLOY_TOKEN', {
      value: 'fake-mock-value-0002',
      projectIds: [],
    });
    expect(replaced.projectIds).toEqual([]);
    expect(replaced.description).toBe('Staging');
    expect(mockSecretValue('DEPLOY_TOKEN')).toBe('fake-mock-value-0002');

    await client.deleteSecret('DEPLOY_TOKEN');
    expect(mockSecretValue('DEPLOY_TOKEN')).toBeUndefined();
    expect((await client.listSecrets()).items).toEqual([]);
  });

  it('refuses a taken name 409, an unknown project 400 and an unknown secret 404', async () => {
    await client.createSecret({ name: 'API_TOKEN', value: VALUE });
    expect((await failure(client.createSecret({ name: 'API_TOKEN', value: VALUE }))).code).toBe(
      'name_taken',
    );
    expect(
      (
        await failure(
          client.createSecret({
            name: 'OTHER',
            value: VALUE,
            projectIds: ['01ARZ3NDEKTSV4RRFFQ69G5FAV'],
          }),
        )
      ).code,
    ).toBe('validation_failed');
    expect((await failure(client.updateSecret('NOPE', { description: 'x' }))).code).toBe(
      'not_found',
    );
    expect((await failure(client.deleteSecret('NOPE'))).code).toBe('not_found');
  });

  it('refuses a reserved name sent past the SDK, without echoing the value', async () => {
    const response = await fetch('http://mock.local/api/v1/secrets', {
      method: 'POST',
      headers: { authorization: 'Bearer mock', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'PATH', value: VALUE }),
    });
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain(VALUE);
  });

  it('needs the session token', async () => {
    const response = await fetch('http://mock.local/api/v1/secrets');
    expect(response.status).toBe(401);
  });
});

describe('D270 mock GET /approvals', () => {
  it('lists every pending approval across runs, oldest first, with the task when one owns the run', async () => {
    const project = db.createProject({ name: 'Shop' });
    const team = db.createWorkflow(project.id, 'Team');
    const task = createTask(db, project.id, { title: 'Ship it', workflowId: team.id });
    const later = seedPendingApproval(db, {
      projectId: project.id,
      workflowId: team.id,
      taskId: task.id,
      requestedAt: '2026-10-07T10:05:00.000Z',
    });
    const earlier = seedPendingApproval(db, {
      nodeName: 'Cleaner',
      requestedAt: '2026-10-07T10:01:00.000Z',
    });

    expect((await client.listPendingApprovals()).items).toEqual([
      {
        request: earlier.request,
        workflowId: earlier.run.workflowId,
        projectId: earlier.run.projectId,
      },
      { request: later.request, workflowId: team.id, projectId: project.id, taskId: task.id },
    ]);

    // A decision takes it out of the inbox (round 3's handler).
    await client.approveNodeRun(earlier.nodeRun.id);
    expect((await client.listPendingApprovals()).items.map((item) => item.request.id)).toEqual([
      later.request.id,
    ]);
  });
});
