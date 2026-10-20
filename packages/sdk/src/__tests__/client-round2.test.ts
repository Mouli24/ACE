import { describe, expect, it } from 'vitest';

import { createAceClient } from '../index.js';

const P = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const W = '01ARZ3NDEKTSV4RRFFQ69G5FAW';
const R = '01ARZ3NDEKTSV4RRFFQ69G5FB0';
const N = '01ARZ3NDEKTSV4RRFFQ69G5FB1';
const NOW = '2026-09-23T00:00:00.000Z';

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function recorder(responses: unknown[]) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    return new Response(JSON.stringify(responses.shift() ?? {}), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { calls, client: createAceClient({ baseUrl: 'http://x', token: 't', fetch: fetchImpl }) };
}

const provider = {
  id: P,
  type: 'mock' as const,
  name: 'Mock',
  keySet: false,
  status: 'CONNECTED' as const,
  concurrency: 20,
  createdAt: NOW,
  updatedAt: NOW,
};

const run = {
  id: R,
  workflowId: W,
  projectId: P,
  status: 'RUNNING' as const,
  snapshot: { version: 1, nodes: [], edges: [] },
  inputs: {},
  preflightIssues: [],
  totals: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
  startedAt: NOW,
};

describe('round 2 §2.5 endpoints', () => {
  it('providers: list, create, get, update, check, refresh models, detect, delete with confirm', async () => {
    const { calls, client } = recorder([
      { items: [provider] },
      provider,
      provider,
      provider,
      { status: 'CONNECTED', checkedAt: NOW },
      { models: [], refreshedAt: NOW },
      { ollama: { baseUrl: 'http://127.0.0.1:11434', detected: true } },
      undefined,
    ]);

    await client.listProviders();
    await client.createProvider({ type: 'mock', name: 'Mock' });
    await client.getProvider(P);
    await client.updateProvider(P, { name: 'Renamed' });
    await client.checkProvider(P);
    await client.refreshModels(P);
    await client.detectProviders();
    await client.deleteProvider(P, { confirm: true });

    expect(calls.map((c) => `${c.method} ${c.url.replace('http://x/api/v1', '')}`)).toEqual([
      'GET /providers',
      'POST /providers',
      `GET /providers/${P}`,
      `PATCH /providers/${P}`,
      `POST /providers/${P}/check`,
      `POST /providers/${P}/refresh-models`,
      'GET /providers/detect',
      `DELETE /providers/${P}?confirm=true`,
    ]);
  });

  it('D380 patchModelCapabilities PATCHes the encoded model id and validates the body', async () => {
    const model = {
      id: '01JBXQ8Z9KQ4R7N2VWXYZ0MDE1',
      providerId: P,
      modelId: 'models/gemini:3',
      displayName: 'Gemini 3',
      inputTypes: ['text'],
      outputTypes: ['text'],
      contextWindow: 65_536,
      supportsTools: true,
      supportsJson: false,
      available: true,
      source: 'discovered',
      lastCheckedAt: NOW,
      capabilitiesSetByPerson: true,
    };
    const { calls, client } = recorder([model]);

    const updated = await client.patchModelCapabilities(P, 'models/gemini:3', {
      supportsTools: true,
      contextWindow: 65_536,
    });

    expect(updated.capabilitiesSetByPerson).toBe(true);
    expect(`${calls[0]?.method} ${calls[0]?.url.replace('http://x/api/v1', '')}`).toBe(
      `PATCH /providers/${P}/models/models%2Fgemini%3A3`,
    );
    await expect(client.patchModelCapabilities(P, 'm', { contextWindow: 5 })).rejects.toThrow();
  });

  it('X1 detectClis asks GET /providers/detect/clis', async () => {
    const { calls, client } = recorder([{ items: [] }]);
    expect(await client.detectClis()).toEqual({ items: [] });
    expect(calls.map((c) => `${c.method} ${c.url.replace('http://x/api/v1', '')}`)).toEqual([
      'GET /providers/detect/clis',
    ]);
  });

  it('createProvider does not force the caller to supply concurrency (§2.1 says optional)', async () => {
    const { calls, client } = recorder([provider]);
    await client.createProvider({
      type: 'openai_compatible',
      name: 'Local',
      baseUrl: 'http://127.0.0.1:1234',
    });
    expect(calls[0]?.body).toMatchObject({ type: 'openai_compatible', name: 'Local' });
  });

  it('a provider still in use answers 409 with the node ids, surfaced on AceApiError.details', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          error: {
            kind: 'workflow',
            code: 'provider_in_use',
            message: 'in use',
            details: { nodeIds: [N] },
            retryable: false,
          },
        }),
        { status: 409, headers: { 'content-type': 'application/json' } },
      );
    const client = createAceClient({ baseUrl: 'http://x', token: 't', fetch: fetchImpl });
    const error = await client.deleteProvider(P).catch((e: unknown) => e);
    expect(error).toMatchObject({
      status: 409,
      code: 'provider_in_use',
      details: { nodeIds: [N] },
    });
  });

  it('models: filters travel as query parameters', async () => {
    const { calls, client } = recorder([{ items: [], refreshedAt: NOW }]);
    await client.listModels({
      providerId: P,
      inputType: 'text',
      outputType: 'json',
      available: true,
    });
    expect(calls[0]?.url).toBe(
      `http://x/api/v1/models?providerId=${P}&inputType=text&outputType=json&available=true`,
    );
  });

  it('runs: start, list, get, node runs, events after a seq', async () => {
    const { calls, client } = recorder([
      run,
      { items: [] },
      run,
      [],
      {
        id: N,
        runId: R,
        nodeId: N,
        iteration: 1,
        attempt: 1,
        status: 'COMPLETED',
        inputEnvelopes: [],
        usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
        verdicts: [],
        toolCalls: [],
      },
      [],
    ]);

    await client.startRun(W, { inputs: {} });
    await client.listRuns(W, { limit: 20 });
    await client.getRun(R);
    await client.listNodeRuns(R);
    await client.getNodeRun(N);
    await client.listRunEvents(R, { afterSeq: 7 });

    expect(calls.map((c) => `${c.method} ${c.url.replace('http://x/api/v1', '')}`)).toEqual([
      `POST /workflows/${W}/runs`,
      `GET /workflows/${W}/runs?limit=20`,
      `GET /runs/${R}`,
      `GET /runs/${R}/node-runs`,
      `GET /node-runs/${N}`,
      `GET /runs/${R}/events?afterSeq=7`,
    ]);
    expect(calls[0]?.body).toEqual({ inputs: {} });
  });
});
