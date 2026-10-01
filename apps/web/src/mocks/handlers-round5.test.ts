import {
  ERROR_KINDS,
  EngineEventSchema,
  HealthMetricsSchema,
  InstantiateTemplateResponseSchema,
  KbDocumentSchema,
  KnowledgeBaseSchema,
  MemoryEntrySchema,
  SearchResponseSchema,
  SettingsSchema,
  TEMPLATE_IDS,
  TemplateSchema,
  UsageResponseSchema,
  BackupImportResponseSchema,
  type InstantiateTemplateResponse,
  type KbDocument,
  type KnowledgeBase,
  type MemoryEntry,
  type SearchResponse,
  type UsageResponse,
} from '@ace/contracts';
import { setupServer } from 'msw/node';

import { newId } from '../lib/ulid';
import { MockDb } from './db';
import { createFakeWebSocket } from './fake-socket';
import { createHandlers } from './handlers';
import { createRound2Handlers, setScenario, stopScenario } from './handlers-round2';
import { createRound3Handlers } from './handlers-round3';
import { createRound4Handlers } from './handlers-round4';
import { createRound5Handlers } from './handlers-round5';
import { failNextIngest, setIngestPace } from './knowledge';
import {
  CORRUPT_PDF_FIXTURE,
  KB_FIXTURES,
  LEAVE_SENTENCE,
  PARAPHRASE_QUERY,
  RARE_TERM,
  type KbFixture,
} from './knowledge-fixtures';
import { seedMemory, seedUsage } from './seeds-round5';
import { mockProviderOf } from './templates';
import { readZip } from './zip';

/**
 * The round 5 MSW seam (§2.9): knowledge bases with a staged ingestion, hybrid search, memory,
 * usage, health, templates, settings and backup — every answer parsed with the contract schema the
 * SDK will parse it with, so the M5 screens are built on shapes the engine (A5) must also give.
 */

const db = new MockDb({ persist: false });
const server = setupServer(
  ...createRound5Handlers(db),
  ...createRound4Handlers(db),
  ...createRound3Handlers(db),
  ...createRound2Handlers(db),
  ...createHandlers(db),
);
const FakeWS = createFakeWebSocket(db);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());
beforeEach(() => {
  stopScenario();
  db.reset();
  setScenario('linear-complete');
  setIngestPace(1);
  failNextIngest(false);
});
afterEach(() => stopScenario());

const enc = new TextEncoder();

async function call<T>(
  method: string,
  path: string,
  payload?: unknown,
  token = true,
): Promise<{ status: number; body: T; headers: Headers }> {
  const response = await fetch(`http://mock.local/api/v1${path}`, {
    method,
    headers: {
      ...(token ? { authorization: 'Bearer mock' } : {}),
      'content-type': 'application/json',
    },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: (text === '' ? undefined : JSON.parse(text)) as T,
    headers: response.headers,
  };
}

/** The multipart wire format a browser `FormData` upload sends, field `file`. */
async function multipart(path: string, bytes: Uint8Array, filename: string, mime: string) {
  const boundary = `----aceMock${Math.random().toString(16).slice(2)}`;
  const head = enc.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${mime}\r\n\r\n`,
  );
  const tail = enc.encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(head.length + bytes.length + tail.length);
  body.set(head, 0);
  body.set(bytes, head.length);
  body.set(tail, head.length + bytes.length);
  const response = await fetch(`http://mock.local/api/v1${path}`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer mock',
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });
  return { status: response.status, body: (await response.json()) as unknown };
}

const uploadFixture = async (fixture: KbFixture) =>
  (await multipart('/artifacts', fixture.bytes(), fixture.name, fixture.mime)).body as {
    id: string;
  };

interface Frame {
  type: string;
  payload: Record<string, unknown>;
  seq?: number;
}

function watchEngine() {
  const frames: Frame[] = [];
  const socket = new FakeWS('ws://mock.local/ws?token=mock');
  socket.onmessage = (event) => {
    const frame = JSON.parse(String((event as MessageEvent<string>).data)) as Frame;
    if (frame.type !== 'hello') frames.push(frame);
  };
  socket.onopen = () =>
    socket.send(JSON.stringify({ type: 'subscribe', payload: { scope: 'engine' } }));
  return { frames, of: (type: string) => frames.filter((f) => f.type === type) };
}

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

async function newKnowledgeBase(name = 'Handbook'): Promise<KnowledgeBase> {
  const project = db.createProject({ name: 'RAG' });
  const provider = mockProviderOf(db);
  const created = await call<KnowledgeBase>('POST', `/projects/${project.id}/knowledge-bases`, {
    name,
    embeddingProviderId: provider.id,
    embeddingModelId: 'mock-embed',
  });
  expect(created.status).toBe(201);
  return KnowledgeBaseSchema.parse(created.body);
}

async function addAndSettle(kb: KnowledgeBase, fixtures: readonly KbFixture[]) {
  const docs: KbDocument[] = [];
  for (const fixture of fixtures) {
    const artifact = await uploadFixture(fixture);
    const added = await call<KbDocument>('POST', `/knowledge-bases/${kb.id}/documents`, {
      artifactId: artifact.id,
    });
    expect(added.status).toBe(202);
    docs.push(KbDocumentSchema.parse(added.body));
  }
  await vi.waitFor(
    async () => {
      const list = await call<{ items: KbDocument[] }>(
        'GET',
        `/knowledge-bases/${kb.id}/documents`,
      );
      const unsettled = list.body.items
        .filter((doc) => doc.status !== 'ready' && doc.status !== 'failed')
        .map((doc) => `${doc.name}: ${doc.status}`);
      expect(unsettled).toEqual([]);
    },
    { timeout: 5000 },
  );
  return docs;
}

const search = async (kbId: string, query: string, mode?: string, k?: number) => {
  const response = await call<SearchResponse>('POST', `/knowledge-bases/${kbId}/query`, {
    query,
    ...(mode === undefined ? {} : { mode }),
    ...(k === undefined ? {} : { k }),
  });
  expect(response.status).toBe(200);
  return SearchResponseSchema.parse(response.body);
};

/* ---------------------------------------------------------------- knowledge bases */

describe('FR-RAG-001 / TC-RAG-001 knowledge base CRUD', () => {
  it('creates with the default chunk settings, lists as { items }, patches and deletes', async () => {
    const kb = await newKnowledgeBase();
    expect(kb).toMatchObject({ chunkSize: 700, chunkOverlap: 90, documentCount: 0 });

    const listed = await call<{ items: KnowledgeBase[] }>(
      'GET',
      `/projects/${kb.projectId}/knowledge-bases`,
    );
    expect(listed.body.items.map((item) => KnowledgeBaseSchema.parse(item).id)).toEqual([kb.id]);

    const patched = await call<KnowledgeBase>('PATCH', `/knowledge-bases/${kb.id}`, {
      name: 'Renamed',
      chunkSize: 400,
    });
    expect(KnowledgeBaseSchema.parse(patched.body)).toMatchObject({
      name: 'Renamed',
      chunkSize: 400,
    });

    // the embedder is fixed at creation (D235), and an overlap must stay under the stored size
    expect(
      (await call('PATCH', `/knowledge-bases/${kb.id}`, { embeddingModelId: 'x' })).status,
    ).toBe(400);
    expect((await call('PATCH', `/knowledge-bases/${kb.id}`, { chunkOverlap: 400 })).status).toBe(
      400,
    );

    expect((await call('DELETE', `/knowledge-bases/${kb.id}`)).status).toBe(204);
    expect((await call('GET', `/knowledge-bases/${kb.id}`)).status).toBe(404);
  });

  it('refuses an embedder that does not exist, and a request without the token', async () => {
    const project = db.createProject({ name: 'RAG' });
    const bad = await call('POST', `/projects/${project.id}/knowledge-bases`, {
      name: 'x',
      embeddingProviderId: '01J00000000000000000000000',
      embeddingModelId: 'mock-embed',
    });
    expect(bad.status).toBe(400);
    expect(
      (await call('GET', `/projects/${project.id}/knowledge-bases`, undefined, false)).status,
    ).toBe(401);
  });
});

/* ---------------------------------------------------------------- ingestion */

describe('TC-RAG-002 / TC-RAG-003 ingestion: every type, and a corrupt file among six', () => {
  it('five documents reach ready; the corrupt PDF fails at parsing with a reason; siblings unaffected', async () => {
    const socket = watchEngine();
    await tick();
    const kb = await newKnowledgeBase();
    const fixtures = [...KB_FIXTURES.slice(0, 2), CORRUPT_PDF_FIXTURE, ...KB_FIXTURES.slice(2, 5)];
    const docs = await addAndSettle(kb, fixtures);
    expect(docs.every((doc) => doc.status === 'pending')).toBe(true);

    const list = (
      await call<{ items: KbDocument[] }>('GET', `/knowledge-bases/${kb.id}/documents`)
    ).body.items.map((doc) => KbDocumentSchema.parse(doc));
    const corrupt = list.find((doc) => doc.name === CORRUPT_PDF_FIXTURE.name)!;
    expect(corrupt.status).toBe('failed');
    expect(corrupt.error).toBe('Could not parse PDF: the file is damaged or not a PDF.');
    const good = list.filter((doc) => doc.id !== corrupt.id);
    expect(good).toHaveLength(5);
    expect(good.every((doc) => doc.status === 'ready' && doc.chunkCount > 0)).toBe(true);
    expect(good.every((doc) => doc.ingestedAt !== undefined)).toBe(true);

    const base = KnowledgeBaseSchema.parse((await call('GET', `/knowledge-bases/${kb.id}`)).body);
    expect(base.documentCount).toBe(6);
    expect(base.chunkCount).toBe(good.reduce((sum, doc) => sum + doc.chunkCount, 0));

    // kb.ingest rides the engine scope, persisted, and walks the stages with its progress climbing
    await vi.waitFor(() => expect(socket.of('kb.ingest').length).toBeGreaterThan(0));
    for (const frame of socket.of('kb.ingest')) {
      expect(EngineEventSchema.safeParse(frame).success).toBe(true);
      expect(frame.seq).toBeGreaterThan(0);
    }
    const ofDoc = (id: string) =>
      socket.of('kb.ingest').filter((frame) => frame.payload.documentId === id);
    const readyDoc = good[0]!;
    expect(ofDoc(readyDoc.id).map((f) => f.payload.status)).toEqual([
      'pending',
      'parsing',
      'chunking',
      'embedding',
      'embedding',
      'embedding',
      'ready',
    ]);
    const progress = ofDoc(readyDoc.id).map((f) => f.payload.progress as number);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(progress.at(-1)).toBe(1);
    const failedFrames = ofDoc(corrupt.id);
    expect(failedFrames.at(-1)!.payload).toMatchObject({
      status: 'failed',
      error: corrupt.error,
    });
    expect(failedFrames.some((f) => f.payload.status === 'chunking')).toBe(false);
  });

  it('every chunk names a resolvable source and its heading path', async () => {
    const kb = await newKnowledgeBase();
    await addAndSettle(kb, KB_FIXTURES);
    const chunks = db.kbChunksOf(kb.id);
    expect(chunks.length).toBeGreaterThanOrEqual(KB_FIXTURES.length);
    expect(chunks.map((chunk) => chunk.source)).toEqual(
      expect.arrayContaining([
        'security-handbook.pdf#Incident response',
        'leave-policy.docx#Annual leave',
        'onboarding.md#First day',
        'architecture.html#Storage',
        'release-notes.txt#lines 1-3',
        'retry-policy.ts#lines 1-4',
      ]),
    );
    // code splits on top-level declarations, its doc comment kept with it
    const code = chunks.filter((chunk) => chunk.source.startsWith('retry-policy.ts#'));
    expect(code).toHaveLength(2);
    expect(code[0]!.text).toMatch(/^\/\*\* Exponential backoff[\s\S]*function backoffDelay/);
    expect(code[1]!.text).toMatch(/^\/\*\* How many retries[\s\S]*class RetryBudget/);
    expect(chunks.find((c) => c.source === 'onboarding.md#First day')!.headings).toEqual([
      'Onboarding guide',
      'First day',
    ]);
  });

  it('failNextIngest fails the next document whatever its bytes', async () => {
    const kb = await newKnowledgeBase();
    failNextIngest();
    await addAndSettle(kb, [KB_FIXTURES[2]!]);
    const [doc] = db.kbDocumentsOf(kb.id);
    expect(doc).toMatchObject({ status: 'failed', chunkCount: 0 });
  });

  it('reindex sends every document through the pipeline again (202)', async () => {
    const kb = await newKnowledgeBase();
    await addAndSettle(kb, KB_FIXTURES.slice(0, 2));
    await call('PATCH', `/knowledge-bases/${kb.id}`, { chunkSize: 200, chunkOverlap: 0 });
    const reindexed = await call('POST', `/knowledge-bases/${kb.id}/reindex`);
    expect(reindexed.status).toBe(202);
    expect(db.kbDocumentsOf(kb.id).every((doc) => doc.status === 'pending')).toBe(true);
    await vi.waitFor(() =>
      expect(db.kbDocumentsOf(kb.id).every((doc) => doc.status === 'ready')).toBe(true),
    );
  });
});

/* ---------------------------------------------------------------- search */

describe('FR-RAG-004 search: keyword, vector, hybrid', () => {
  it('TC-RAG-004: the exact rare term is found by the keyword arm', async () => {
    const kb = await newKnowledgeBase();
    await addAndSettle(kb, KB_FIXTURES);
    const keyword = await search(kb.id, RARE_TERM, 'keyword');
    expect(keyword.hits[0]!.text).toContain(RARE_TERM);
    expect(keyword.hits[0]!.via).toBe('keyword');
    expect(keyword.hits[0]!.source).toBe('security-handbook.pdf#Incident response');

    const hybrid = await search(kb.id, RARE_TERM);
    expect(hybrid.hits.slice(0, 3).some((hit) => hit.text.includes(RARE_TERM))).toBe(true);
    expect(hybrid.tookMs).toBeGreaterThanOrEqual(0);
  });

  it('TC-RAG-005: a paraphrase is found by the vector arm', async () => {
    const kb = await newKnowledgeBase();
    await addAndSettle(kb, KB_FIXTURES);
    const vector = await search(kb.id, PARAPHRASE_QUERY, 'vector');
    expect(vector.hits.slice(0, 3).some((hit) => hit.text.includes(LEAVE_SENTENCE))).toBe(true);
    expect(vector.hits.every((hit) => hit.via === 'vector')).toBe(true);

    const hybrid = await search(kb.id, PARAPHRASE_QUERY);
    expect(hybrid.hits.slice(0, 3).some((hit) => hit.text.includes(LEAVE_SENTENCE))).toBe(true);
  });

  it('honours k, scores in 0..1 best first, and fuses with the contract rule (D231)', async () => {
    const kb = await newKnowledgeBase();
    await addAndSettle(kb, KB_FIXTURES);
    const result = await search(kb.id, 'leave policy days', 'hybrid', 2);
    expect(result.hits.length).toBeLessThanOrEqual(2);
    const scores = result.hits.map((hit) => hit.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    // a hit both arms found can score above 0.5; one arm alone never does
    for (const hit of result.hits)
      if (hit.via !== 'both') expect(hit.score).toBeLessThanOrEqual(0.5);
    expect((await call('POST', `/knowledge-bases/${kb.id}/query`, { query: '' })).status).toBe(400);
  });

  it('TC-RAG-008: a deleted document is no longer returned', async () => {
    const kb = await newKnowledgeBase();
    const docs = await addAndSettle(kb, KB_FIXTURES);
    const handbook = docs.find((doc) => doc.name === 'security-handbook.pdf')!;
    expect((await call('DELETE', `/kb-documents/${handbook.id}`)).status).toBe(204);

    const after = await search(kb.id, RARE_TERM);
    expect(after.hits.some((hit) => hit.documentId === handbook.id)).toBe(false);
    expect(after.hits.some((hit) => hit.text.includes(RARE_TERM))).toBe(false);
    expect(
      KnowledgeBaseSchema.parse((await call('GET', `/knowledge-bases/${kb.id}`)).body),
    ).toMatchObject({ documentCount: KB_FIXTURES.length - 1 });
    expect((await call('DELETE', `/kb-documents/${handbook.id}`)).status).toBe(404);
  });
});

/* ---------------------------------------------------------------- memory */

describe('FR-MEM-004 memory: list, delete one, clear', () => {
  it('lists oldest first, and every delete is a memory.updated on the engine scope', async () => {
    const socket = watchEngine();
    await tick();
    const nodeId = newId();
    seedMemory(db, nodeId, [
      { key: 'user_name', value: 'Ada' },
      { key: 'city', value: 'Paris' },
      { key: 'team', value: 'Core' },
    ]);
    const listed = await call<MemoryEntry[]>('GET', `/nodes/${nodeId}/memory`);
    const entries = listed.body.map((entry) => MemoryEntrySchema.parse(entry));
    expect(entries.map((entry) => entry.key)).toEqual(['user_name', 'city', 'team']);

    expect((await call('DELETE', `/nodes/${nodeId}/memory/${entries[1]!.id}`)).status).toBe(204);
    expect((await call('DELETE', `/nodes/${nodeId}/memory/${entries[1]!.id}`)).status).toBe(404);
    expect((await call('DELETE', `/nodes/${nodeId}/memory`)).status).toBe(204);
    expect((await call<MemoryEntry[]>('GET', `/nodes/${nodeId}/memory`)).status).toBe(404);

    await vi.waitFor(() => expect(socket.of('memory.updated')).toHaveLength(3));
    const [saved, deletedOne, cleared] = socket.of('memory.updated');
    for (const frame of socket.of('memory.updated')) {
      expect(EngineEventSchema.safeParse(frame).success).toBe(true);
    }
    expect(saved!.payload.ops).toHaveLength(3);
    expect(deletedOne!.payload).toEqual({ nodeId, ops: [{ op: 'delete', key: 'city' }] });
    expect(cleared!.payload.ops).toEqual([
      { op: 'delete', key: 'user_name' },
      { op: 'delete', key: 'team' },
    ]);
  });

  it('answers an empty list for a known node with no memory, 404 for an unknown one', async () => {
    const project = db.createProject({ name: 'p' });
    const instantiated = (
      await call<InstantiateTemplateResponse>('POST', '/templates/linear-chain/instantiate', {
        projectId: project.id,
      })
    ).body;
    const agent = instantiated.nodes.find((node) => node.kind === 'agent')!;
    expect((await call('GET', `/nodes/${agent.id}/memory`)).body).toEqual([]);
    expect((await call('GET', '/nodes/nope/memory')).status).toBe(404);
  });
});

/* ---------------------------------------------------------------- usage + health */

describe('FR-OBS-002 / FR-OBS-004 usage (D234)', () => {
  it('buckets by provider and day, ordered by key, totals the exact sum', async () => {
    const seeded = seedUsage(db, 5);
    const response = await call<UsageResponse>('GET', '/usage?groupBy=provider&groupBy=day');
    const usage = UsageResponseSchema.parse(response.body);
    expect(usage.buckets.every((b) => Object.keys(b.key).join() === 'provider,day')).toBe(true);
    const keys = usage.buckets.map((b) => `${b.key.provider}|${b.key.day}`);
    expect(keys).toEqual([...keys].sort());
    expect(usage.totals.tokensIn).toBe(usage.buckets.reduce((s, b) => s + b.tokensIn, 0));
    expect(usage.totals.tokensOut).toBe(usage.buckets.reduce((s, b) => s + b.tokensOut, 0));
    expect(usage.totals.costUsd).toBeCloseTo(
      usage.buckets.reduce((s, b) => s + b.costUsd, 0),
      9,
    );
    const runTotal = seeded.runIds
      .map((id) => db.getRun(id)!.totals.tokensIn)
      .reduce((a, b) => a + b, 0);
    expect(usage.totals.tokensIn).toBe(runTotal);
    expect(usage.buckets.reduce((s, b) => s + b.runs, 0)).toBe(seeded.runIds.length);
  });

  it('a single groupBy reads as a list of one; from is inclusive and to exclusive', async () => {
    seedUsage(db, 3);
    const byModel = UsageResponseSchema.parse((await call('GET', '/usage?groupBy=model')).body);
    expect(byModel.buckets.map((b) => b.key.model)).toEqual(['claude-haiku-4-5', 'mock-text']);

    const today = new Date().toISOString().slice(0, 10);
    const from = `${today}T10:00:00.000Z`;
    const onlyToday = UsageResponseSchema.parse(
      (await call('GET', `/usage?groupBy=day&from=${from}`)).body,
    );
    expect(onlyToday.buckets.map((b) => b.key.day)).toEqual([today]);
    const beforeToday = UsageResponseSchema.parse(
      (await call('GET', `/usage?groupBy=day&to=${from}`)).body,
    );
    expect(beforeToday.buckets.map((b) => b.key.day)).not.toContain(today);

    expect((await call('GET', '/usage')).status).toBe(400);
    expect((await call('GET', '/usage?groupBy=colour')).status).toBe(400);
  });
});

describe('FR-OBS-007 health metrics', () => {
  it('names every error kind, keys latency by provider and counts runs', async () => {
    const seeded = seedUsage(db, 4);
    const health = HealthMetricsSchema.parse((await call('GET', '/metrics/health')).body);
    expect(Object.keys(health.nodeFailuresByKind).sort()).toEqual([...ERROR_KINDS].sort());
    expect(health.runs.started).toBe(seeded.runIds.length);
    expect(health.runs.completed).toBe(seeded.runIds.length);
    for (const id of seeded.providerIds) {
      const latency = health.providerLatencyMs[id]!;
      expect(latency.p50).toBeLessThanOrEqual(latency.p95);
    }
  });
});

/* ---------------------------------------------------------------- templates */

describe('FR-ONB-002 templates', () => {
  it('lists the four templates as a bare array, rag-qa requiring a knowledge base', async () => {
    const templates = (await call<unknown[]>('GET', '/templates')).body.map((t) =>
      TemplateSchema.parse(t),
    );
    expect(templates.map((t) => t.id)).toEqual([...TEMPLATE_IDS]);
    expect(templates.filter((t) => t.requires.knowledgeBase).map((t) => t.id)).toEqual(['rag-qa']);
  });

  it.each(TEMPLATE_IDS)('%s instantiates into a valid graph on the mock provider', async (id) => {
    const response = await call<InstantiateTemplateResponse>(
      'POST',
      `/templates/${id}/instantiate`,
      {
        projectName: `Try ${id}`,
      },
    );
    expect(response.status).toBe(201);
    const body = InstantiateTemplateResponseSchema.parse(response.body);
    expect(body.project.name).toBe(`Try ${id}`);
    const validation = await call<{ issues: { severity: string; code: string }[] }>(
      'POST',
      `/workflows/${body.workflow.id}/validate`,
    );
    expect(validation.body.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    if (id === 'rag-qa') {
      expect(body.knowledgeBaseId).toBeDefined();
      const docs = db.kbDocumentsOf(body.knowledgeBaseId!);
      expect(docs).toHaveLength(1);
      expect(docs[0]!.status).toBe('ready');
      expect(db.getKnowledgeBase(body.knowledgeBaseId!)!.embeddingModelId).toBe('mock-embed');
    } else {
      expect(body.knowledgeBaseId).toBeUndefined();
    }
  });

  it('uses an existing project, refuses both or an unknown one, and 404s an unknown template', async () => {
    const project = db.createProject({ name: 'Mine' });
    const into = await call<InstantiateTemplateResponse>(
      'POST',
      '/templates/linear-chain/instantiate',
      {
        projectId: project.id,
      },
    );
    expect(into.body.project.id).toBe(project.id);
    const named = await call<InstantiateTemplateResponse>(
      'POST',
      '/templates/linear-chain/instantiate',
    );
    expect(named.body.project.name).toBe('Linear chain');
    expect(
      (
        await call('POST', '/templates/linear-chain/instantiate', {
          projectId: project.id,
          projectName: 'x',
        })
      ).status,
    ).toBe(400);
    expect(
      (await call('POST', '/templates/linear-chain/instantiate', { projectId: newId() })).status,
    ).toBe(404);
    expect((await call('POST', '/templates/nope/instantiate', {})).status).toBe(404);
  });
});

/* ---------------------------------------------------------------- settings + backup */

describe('FR-SYS-005 / NFR-PRIV-01 settings', () => {
  it('starts with onboarding not done and telemetry off, and refuses to turn telemetry on', async () => {
    const settings = SettingsSchema.parse((await call('GET', '/settings')).body);
    expect(settings).toMatchObject({ onboardingCompleted: false, telemetryEnabled: false });
    const done = await call('PATCH', '/settings', { onboardingCompleted: true });
    expect(SettingsSchema.parse(done.body).onboardingCompleted).toBe(true);
    expect((await call('PATCH', '/settings', { telemetryEnabled: true })).status).toBe(400);
  });
});

describe('FR-SYS-012 / TC-SYS-014 backup and restore', () => {
  it('exports a real zip without keys, and restores it into a clean engine', async () => {
    db.createProject({ name: 'Keep me' });
    db.createProvider({ type: 'anthropic', name: 'Cloud', apiKey: 'sk-ant-secret-123' });
    seedUsage(db, 2);
    const artifactCount = db.listArtifacts().length;
    const projectCount = db.listProjects().length;
    const runCount = db.allRuns().length;

    const response = await fetch('http://mock.local/api/v1/backup/export', {
      method: 'POST',
      headers: { authorization: 'Bearer mock' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/zip');
    const zip = new Uint8Array(await response.arrayBuffer());
    expect(String.fromCharCode(zip[0]!, zip[1]!)).toBe('PK');
    const entry = readZip(zip)!.get('ace-backup.json')!;
    expect(new TextDecoder().decode(entry)).not.toContain('sk-ant-secret-123');

    db.reset();
    expect(db.listProjects()).toHaveLength(0);
    const restored = await multipart('/backup/import', zip, 'backup.zip', 'application/zip');
    expect(restored.status).toBe(200);
    expect(BackupImportResponseSchema.parse(restored.body)).toEqual({
      restored: { projects: projectCount, runs: runCount, artifacts: artifactCount },
    });
    expect(db.listProjects().map((p) => p.name)).toContain('Keep me');
  });

  it('refuses a file that is not an ACE backup', async () => {
    const bad = await multipart('/backup/import', enc.encode('nope'), 'x.zip', 'application/zip');
    expect(bad.status).toBe(400);
  });
});
