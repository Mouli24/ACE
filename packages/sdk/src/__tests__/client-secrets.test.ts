import type { PendingApproval, Secret } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { AceApiError, createAceClient } from '../index.js';

/*
 * ACE parity P1 (D270, D274): the SDK's secrets and approvals-inbox methods — the paths and bodies
 * they send, and the contract each answer is parsed with.
 */

const P = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const R = '01ARZ3NDEKTSV4RRFFQ69G5FR0';
const W = '01ARZ3NDEKTSV4RRFFQ69G5FAW';
const T = '01ARZ3NDEKTSV4RRFFQ69G5FT0';
const NOW = '2026-10-07T00:00:00.000Z';
/** Obviously fake: no real key is ever written in this repository. */
const VALUE = 'fake-sdk-value-0001';

interface Call {
  url: string;
  method: string;
  body: unknown;
}

type Reply = { status?: number; body?: unknown };

function recorder(responses: Reply[]) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const body = init?.body;
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: body === undefined || body === null ? undefined : JSON.parse(String(body)),
    });
    const next = responses.shift() ?? { body: {} };
    const status = next.status ?? 200;
    if (status === 204) return new Response(null, { status });
    return new Response(JSON.stringify(next.body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { calls, client: createAceClient({ baseUrl: 'http://x', token: 't', fetch: fetchImpl }) };
}

const paths = (calls: Call[]): string[] =>
  calls.map((c) => `${c.method} ${c.url.replace('http://x/api/v1', '')}`);

const secret: Secret = {
  name: 'DEPLOY_TOKEN',
  description: 'Staging',
  projectIds: [P],
  createdAt: NOW,
  updatedAt: NOW,
};

const pending: PendingApproval = {
  request: {
    id: '01ARZ3NDEKTSV4RRFFQ69G5FQ0',
    runId: R,
    nodeRunId: '01ARZ3NDEKTSV4RRFFQ69G5FN0',
    nodeId: '01ARZ3NDEKTSV4RRFFQ69G5FD0',
    nodeName: 'Builder',
    point: 'tool',
    checkType: 'destructive_action',
    reason: 'run_command is destructive',
    preview: 'run_command {"command":"rm -rf build"}',
    requestedAt: NOW,
  },
  workflowId: W,
  projectId: P,
  taskId: T,
};

describe('D274 secrets through the SDK', () => {
  it('lists, creates, updates and deletes on the /secrets paths', async () => {
    const { calls, client } = recorder([
      { body: { items: [secret] } },
      { status: 201, body: secret },
      { body: { ...secret, description: 'Production' } },
      { status: 204 },
    ]);

    expect(await client.listSecrets()).toEqual({ items: [secret] });
    expect(
      await client.createSecret({ name: 'DEPLOY_TOKEN', value: VALUE, projectIds: [P] }),
    ).toEqual(secret);
    expect(
      (
        await client.updateSecret('DEPLOY_TOKEN', {
          value: 'fake-sdk-value-0002',
          description: 'Production',
        })
      ).description,
    ).toBe('Production');
    expect(await client.deleteSecret('DEPLOY_TOKEN')).toBeUndefined();

    expect(paths(calls)).toEqual([
      'GET /secrets',
      'POST /secrets',
      'PATCH /secrets/DEPLOY_TOKEN',
      'DELETE /secrets/DEPLOY_TOKEN',
    ]);
    expect(calls[1]?.body).toEqual({ name: 'DEPLOY_TOKEN', value: VALUE, projectIds: [P] });
    expect(calls[2]?.body).toEqual({ value: 'fake-sdk-value-0002', description: 'Production' });
  });

  it('refuses a reserved or ill-formed name before sending anything', async () => {
    const { calls, client } = recorder([]);
    for (const name of ['PATH', 'ACE_DATA_DIR', 'lower_case', '9LIVES']) {
      const error = await client.createSecret({ name, value: VALUE }).catch((e: unknown) => e);
      expect(AceApiError.is(error)).toBe(true);
      expect(JSON.stringify(error)).not.toContain(VALUE);
    }
    expect(calls).toEqual([]);
  });

  it('refuses an answer that carries a value, which the strict contract forbids', async () => {
    const { client } = recorder([{ body: { items: [{ ...secret, value: VALUE }] } }]);
    const error = await client.listSecrets().catch((e: unknown) => e);
    expect(AceApiError.is(error) && error.code).toBe('invalid_response');
  });

  it('surfaces 409 name_taken as an AceApiError', async () => {
    const { client } = recorder([
      {
        status: 409,
        body: {
          error: {
            kind: 'invalid_config',
            code: 'name_taken',
            message: 'A secret named DEPLOY_TOKEN already exists.',
            retryable: false,
          },
        },
      },
    ]);
    const error = await client
      .createSecret({ name: 'DEPLOY_TOKEN', value: VALUE })
      .catch((e: unknown) => e);
    expect(AceApiError.is(error) && error.code).toBe('name_taken');
    expect(AceApiError.is(error) && error.status).toBe(409);
  });
});

describe('D270 the approvals inbox through the SDK', () => {
  it('reads GET /approvals in the contract shape', async () => {
    const { calls, client } = recorder([{ body: { items: [pending] } }]);
    expect(await client.listPendingApprovals()).toEqual({ items: [pending] });
    expect(paths(calls)).toEqual(['GET /approvals']);
  });
});
