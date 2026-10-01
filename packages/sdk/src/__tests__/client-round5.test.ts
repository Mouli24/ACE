import {
  BACKUP_CONTENT_TYPE,
  BACKUP_UPLOAD_FIELD,
  FORMAT_VERSION,
  type InstantiateTemplateResponse,
  type HealthMetrics,
  type KbDocument,
  type KnowledgeBase,
  type MemoryEntry,
  type SearchResponse,
  type Template,
  type TraceEntry,
  type UsageResponse,
} from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { AceApiError, createAceClient } from '../index.js';

const P = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const W = '01ARZ3NDEKTSV4RRFFQ69G5FAW';
const R = '01ARZ3NDEKTSV4RRFFQ69G5FB0';
const NODE = '01ARZ3NDEKTSV4RRFFQ69G5FB2';
const PRV = '01ARZ3NDEKTSV4RRFFQ69G5FB3';
const ART = '01ARZ3NDEKTSV4RRFFQ69G5FD0';
const KB = '01ARZ3NDEKTSV4RRFFQ69G5FE0';
const DOC = '01ARZ3NDEKTSV4RRFFQ69G5FE1';
const CHUNK = '01ARZ3NDEKTSV4RRFFQ69G5FE2';
const MEM = '01ARZ3NDEKTSV4RRFFQ69G5FE3';
const NOW = '2026-10-02T00:00:00.000Z';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** JSON bodies are parsed; a `FormData` body is kept as it is. */
  body: unknown;
}

type Reply = { status?: number; body?: unknown; raw?: BodyInit; contentType?: string };

/** The recorder from the round 2–4 client tests, which also keeps headers and `FormData` bodies. */
function recorder(responses: Reply[]) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const body = init?.body;
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: { ...((init?.headers as Record<string, string> | undefined) ?? {}) },
      body:
        body === undefined || body === null
          ? undefined
          : body instanceof FormData
            ? body
            : JSON.parse(String(body)),
    });
    const next = responses.shift() ?? { body: {} };
    const status = next.status ?? 200;
    if (status === 204) return new Response(null, { status });
    if (next.raw !== undefined) {
      return new Response(next.raw, {
        status,
        headers: { 'content-type': next.contentType ?? 'application/octet-stream' },
      });
    }
    return new Response(JSON.stringify(next.body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { calls, client: createAceClient({ baseUrl: 'http://x', token: 't', fetch: fetchImpl }) };
}

const paths = (calls: Call[]): string[] =>
  calls.map((c) => `${c.method} ${c.url.replace('http://x/api/v1', '')}`);

const kb: KnowledgeBase = {
  id: KB,
  projectId: P,
  name: 'Handbook',
  embeddingProviderId: PRV,
  embeddingModelId: 'mock-embed',
  chunkSize: 700,
  chunkOverlap: 90,
  documentCount: 0,
  chunkCount: 0,
  createdAt: NOW,
  updatedAt: NOW,
};

const doc: KbDocument = {
  id: DOC,
  knowledgeBaseId: KB,
  artifactId: ART,
  name: 'handbook.md',
  mime: 'text/markdown',
  size: 2048,
  status: 'pending',
  chunkCount: 0,
  createdAt: NOW,
};

const search: SearchResponse = {
  hits: [
    {
      chunkId: CHUNK,
      documentId: DOC,
      text: 'Refunds take five days.',
      score: 0.5,
      source: 'handbook.md#Refunds',
      via: 'keyword',
    },
  ],
  tookMs: 3,
};

const memory: MemoryEntry = {
  id: MEM,
  nodeId: NODE,
  key: 'user_name',
  value: 'Ada',
  createdAt: NOW,
  updatedAt: NOW,
};

const apiError = (code: string, status = 404) => ({
  status,
  body: { error: { kind: 'workflow', code, message: code, retryable: false } },
});

describe('FR-RAG-001 knowledge bases (round 5 §2.9)', () => {
  it('lists a project’s bases as { items } and creates one with the contract defaults', async () => {
    const { calls, client } = recorder([{ body: { items: [kb] } }, { body: kb }]);

    await expect(client.listKnowledgeBases(P)).resolves.toEqual({ items: [kb] });
    await expect(
      client.createKnowledgeBase(P, {
        name: 'Handbook',
        embeddingProviderId: PRV,
        embeddingModelId: 'mock-embed',
      }),
    ).resolves.toEqual(kb);

    expect(paths(calls)).toEqual([
      `GET /projects/${P}/knowledge-bases`,
      `POST /projects/${P}/knowledge-bases`,
    ]);
    expect(calls[1]?.body).toEqual({
      name: 'Handbook',
      embeddingProviderId: PRV,
      embeddingModelId: 'mock-embed',
      chunkSize: 700,
      chunkOverlap: 90,
    });
  });

  it('gets, patches and deletes one base', async () => {
    const { calls, client } = recorder([
      { body: kb },
      { body: { ...kb, name: 'Renamed' } },
      { status: 204 },
    ]);

    await expect(client.getKnowledgeBase(KB)).resolves.toEqual(kb);
    await expect(client.updateKnowledgeBase(KB, { name: 'Renamed' })).resolves.toMatchObject({
      name: 'Renamed',
    });
    await expect(client.deleteKnowledgeBase(KB)).resolves.toBeUndefined();

    expect(paths(calls)).toEqual([
      `GET /knowledge-bases/${KB}`,
      `PATCH /knowledge-bases/${KB}`,
      `DELETE /knowledge-bases/${KB}`,
    ]);
    expect(calls[1]?.body).toEqual({ name: 'Renamed' });
  });

  it('refuses a body the contract refuses before it is sent (overlap ≥ chunk size)', async () => {
    const { calls, client } = recorder([]);
    await expect(
      client.updateKnowledgeBase(KB, { chunkSize: 300, chunkOverlap: 300 }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    // The embedder is fixed at creation, so a PATCH naming it is refused too (D235).
    await expect(
      client.updateKnowledgeBase(KB, { embeddingModelId: 'other' } as never),
    ).rejects.toBeInstanceOf(AceApiError);
    expect(calls).toHaveLength(0);
  });

  it('surfaces a 404 as an AceApiError', async () => {
    const { client } = recorder([apiError('knowledge_base_not_found')]);
    await expect(client.getKnowledgeBase(KB)).rejects.toMatchObject({
      status: 404,
      code: 'knowledge_base_not_found',
    });
  });
});

describe('FR-RAG-002/003/009 knowledge-base documents (round 5 §2.9)', () => {
  it('adds a document (202, pending) and lists them as { items }', async () => {
    const { calls, client } = recorder([{ status: 202, body: doc }, { body: { items: [doc] } }]);

    await expect(client.addKbDocument(KB, { artifactId: ART })).resolves.toEqual(doc);
    await expect(client.listKbDocuments(KB)).resolves.toEqual({ items: [doc] });

    expect(paths(calls)).toEqual([
      `POST /knowledge-bases/${KB}/documents`,
      `GET /knowledge-bases/${KB}/documents`,
    ]);
    expect(calls[0]?.body).toEqual({ artifactId: ART });
  });

  it('deletes one document (204) and reindexes the base (202)', async () => {
    const { calls, client } = recorder([{ status: 204 }, { status: 202 }]);

    await expect(client.deleteKbDocument(DOC)).resolves.toBeUndefined();
    await expect(client.reindexKnowledgeBase(KB)).resolves.toBeUndefined();

    expect(paths(calls)).toEqual([
      `DELETE /kb-documents/${DOC}`,
      `POST /knowledge-bases/${KB}/reindex`,
    ]);
  });

  it('a reindex answering 202 with a body is still accepted', async () => {
    const { client } = recorder([{ status: 202, body: { accepted: true } }]);
    await expect(client.reindexKnowledgeBase(KB)).resolves.toBeUndefined();
  });
});

describe('FR-RAG-004/008 test search (round 5 §2.9)', () => {
  it('posts a SearchRequest with k/mode defaults and parses the SearchResponse', async () => {
    const { calls, client } = recorder([{ body: search }]);

    await expect(client.queryKnowledgeBase(KB, { query: 'refund' })).resolves.toEqual(search);

    expect(paths(calls)).toEqual([`POST /knowledge-bases/${KB}/query`]);
    expect(calls[0]?.body).toEqual({ query: 'refund', k: 5, mode: 'hybrid' });
  });

  it('refuses an empty query, and a response whose score leaves 0..1', async () => {
    const { calls, client } = recorder([
      { body: { ...search, hits: [{ ...search.hits[0], score: 1.5 }] } },
    ]);
    await expect(client.queryKnowledgeBase(KB, { query: '' })).rejects.toMatchObject({
      code: 'validation_failed',
    });
    expect(calls).toHaveLength(0);
    await expect(client.queryKnowledgeBase(KB, { query: 'x' })).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });
});

describe('FR-MEM-004 agent memory (round 5 §2.9)', () => {
  it('lists a bare MemoryEntry[], deletes one entry and clears all', async () => {
    const { calls, client } = recorder([{ body: [memory] }, { status: 204 }, { status: 204 }]);

    await expect(client.listNodeMemory(NODE)).resolves.toEqual([memory]);
    await expect(client.deleteNodeMemoryEntry(NODE, MEM)).resolves.toBeUndefined();
    await expect(client.clearNodeMemory(NODE)).resolves.toBeUndefined();

    expect(paths(calls)).toEqual([
      `GET /nodes/${NODE}/memory`,
      `DELETE /nodes/${NODE}/memory/${MEM}`,
      `DELETE /nodes/${NODE}/memory`,
    ]);
  });
});

describe('FR-OBS-001 run trace (round 5 §2.6)', () => {
  it('reads a bare TraceEntry[]', async () => {
    const trace: TraceEntry[] = [
      { seq: 1, at: NOW, kind: 'run_event', label: 'run.started', detail: { runId: R } },
      {
        seq: 2,
        at: NOW,
        kind: 'node_run',
        nodeId: NODE,
        label: 'Agent',
        detail: null,
        durationMs: 12,
      },
    ];
    const { calls, client } = recorder([{ body: trace }]);
    await expect(client.getRunTrace(R)).resolves.toEqual(trace);
    expect(paths(calls)).toEqual([`GET /runs/${R}/trace`]);
  });
});

describe('FR-OBS-004 usage (round 5 §2.6, D234)', () => {
  const usage: UsageResponse = {
    buckets: [
      {
        key: { provider: PRV, day: '2026-10-01' },
        tokensIn: 10,
        tokensOut: 20,
        costUsd: 0.01,
        runs: 1,
      },
    ],
    totals: { tokensIn: 10, tokensOut: 20, costUsd: 0.01 },
  };

  it('sends groupBy as a repeated query parameter, with from/to', async () => {
    const { calls, client } = recorder([{ body: usage }]);

    await expect(
      client.getUsage({
        from: '2026-10-01T00:00:00.000Z',
        to: '2026-10-02T00:00:00.000Z',
        groupBy: ['provider', 'day'],
      }),
    ).resolves.toEqual(usage);

    const url = new URL(calls[0]?.url ?? '');
    expect(url.pathname).toBe('/api/v1/usage');
    expect(url.searchParams.getAll('groupBy')).toEqual(['provider', 'day']);
    expect(url.searchParams.get('from')).toBe('2026-10-01T00:00:00.000Z');
    expect(url.searchParams.get('to')).toBe('2026-10-02T00:00:00.000Z');
  });

  it('reads a single groupBy as a list of one and leaves an absent range out', async () => {
    const { calls, client } = recorder([{ body: usage }]);
    await client.getUsage({ groupBy: 'model' });
    const url = new URL(calls[0]?.url ?? '');
    expect(url.searchParams.getAll('groupBy')).toEqual(['model']);
    expect(url.searchParams.has('from')).toBe(false);
    expect(url.searchParams.has('to')).toBe(false);
  });

  it('refuses a query the contract refuses (from not before to, a grouping twice)', async () => {
    const { calls, client } = recorder([]);
    await expect(
      client.getUsage({
        from: '2026-10-02T00:00:00.000Z',
        to: '2026-10-01T00:00:00.000Z',
        groupBy: ['day'],
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(client.getUsage({ groupBy: ['day', 'day'] })).rejects.toMatchObject({
      code: 'validation_failed',
    });
    expect(calls).toHaveLength(0);
  });
});

describe('FR-OBS-007 health metrics (round 5 §2.6)', () => {
  it('reads GET /metrics/health', async () => {
    const metrics: HealthMetrics = {
      runs: { started: 2, completed: 1, halted: 1, blocked: 0 },
      nodeFailuresByKind: {
        user_cancelled: 0,
        agent: 0,
        provider: 1,
        auth: 0,
        network: 0,
        invalid_config: 0,
        workflow: 0,
        guardrail: 0,
      },
      providerLatencyMs: { [PRV]: { p50: 10, p95: 40 } },
      guardrailVerdictsByType: { pii: 3 },
      since: NOW,
    };
    const { calls, client } = recorder([{ body: metrics }]);
    await expect(client.getHealthMetrics()).resolves.toEqual(metrics);
    expect(paths(calls)).toEqual(['GET /metrics/health']);
  });
});

describe('FR-ONB-002 templates (round 5 §2.7)', () => {
  it('lists a bare Template[] and instantiates one into a new project', async () => {
    const templates: Template[] = [
      {
        id: 'rag-qa',
        name: 'RAG Q&A',
        description: 'Answer from a knowledge base.',
        requires: { knowledgeBase: true },
      },
    ];
    const instantiated: InstantiateTemplateResponse = {
      project: { id: P, name: 'Demo', folderPath: '/tmp/demo', createdAt: NOW, updatedAt: NOW },
      workflow: {
        id: W,
        projectId: P,
        name: 'RAG Q&A',
        version: 1,
        formatVersion: FORMAT_VERSION,
        createdAt: NOW,
        updatedAt: NOW,
      },
      nodes: [],
      edges: [],
      knowledgeBaseId: KB,
    };
    const { calls, client } = recorder([{ body: templates }, { status: 201, body: instantiated }]);

    await expect(client.listTemplates()).resolves.toEqual(templates);
    await expect(client.instantiateTemplate('rag-qa', { projectName: 'Demo' })).resolves.toEqual(
      instantiated,
    );

    expect(paths(calls)).toEqual(['GET /templates', 'POST /templates/rag-qa/instantiate']);
    expect(calls[1]?.body).toEqual({ projectName: 'Demo' });
  });

  it('refuses naming both a new and an existing project', async () => {
    const { calls, client } = recorder([]);
    await expect(
      client.instantiateTemplate('linear-chain', { projectName: 'Demo', projectId: P }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    expect(calls).toHaveLength(0);
  });
});

describe('FR-SYS-012 backup export and import (round 5 §2.7, TC-SYS-014)', () => {
  it('exportBackup POSTs /backup/export and answers the zip as a Blob', async () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    const { calls, client } = recorder([{ raw: bytes, contentType: BACKUP_CONTENT_TYPE }]);

    const blob = await client.exportBackup();

    expect(blob).toBeInstanceOf(Blob);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
    expect(blob.type).toBe(BACKUP_CONTENT_TYPE);
    expect(paths(calls)).toEqual(['POST /backup/export']);
    expect(calls[0]?.headers.authorization).toBe('Bearer t');
    expect(calls[0]?.headers.accept).toContain(BACKUP_CONTENT_TYPE);
  });

  it('exportBackup surfaces an engine error envelope as an AceApiError', async () => {
    const { client } = recorder([apiError('backup_failed', 500)]);
    await expect(client.exportBackup()).rejects.toMatchObject({
      status: 500,
      code: 'backup_failed',
    });
  });

  it('exportBackup raises a network AceApiError when fetch throws', async () => {
    const client = createAceClient({
      baseUrl: 'http://x',
      token: 't',
      fetch: async () => {
        throw new Error('down');
      },
    });
    await expect(client.exportBackup()).rejects.toMatchObject({ kind: 'network', status: 0 });
  });

  it('importBackup sends the zip as multipart field `file` and parses the restored counts', async () => {
    const restored = { restored: { projects: 2, runs: 5, artifacts: 7 } };
    const { calls, client } = recorder([{ body: restored }]);
    const zip = new Blob([new Uint8Array([0x50, 0x4b])], { type: BACKUP_CONTENT_TYPE });

    await expect(client.importBackup(zip, { filename: 'ace-backup.zip' })).resolves.toEqual(
      restored,
    );

    expect(paths(calls)).toEqual(['POST /backup/import']);
    const call = calls[0];
    expect(call?.body).toBeInstanceOf(FormData);
    const field = (call?.body as FormData).get(BACKUP_UPLOAD_FIELD);
    expect(field).toBeInstanceOf(Blob);
    expect((field as File).name).toBe('ace-backup.zip');
    expect(call?.headers.authorization).toBe('Bearer t');
    // The multipart boundary is fetch's to set.
    expect(call?.headers['content-type']).toBeUndefined();
  });

  it('importBackup surfaces a refused archive and a malformed answer as AceApiErrors', async () => {
    const { client } = recorder([
      apiError('invalid_backup', 400),
      { body: { restored: { projects: -1, runs: 0, artifacts: 0 } } },
    ]);
    const zip = new Blob(['x']);
    await expect(client.importBackup(zip)).rejects.toMatchObject({
      status: 400,
      code: 'invalid_backup',
    });
    await expect(client.importBackup(zip)).rejects.toMatchObject({ code: 'invalid_response' });
  });
});
