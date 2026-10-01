import {
  EngineEventSchema,
  NodeRunSchema,
  RunEventSchema,
  TEMPLATE_IDS,
  TRACE_ENTRY_KINDS,
  TraceResponseSchema,
  UsageResponseSchema,
  type InstantiateTemplateResponse,
  type Node,
  type NodeRun,
  type Run,
  type TraceEntry,
} from '@ace/contracts';
import { setupServer } from 'msw/node';

import { MockDb } from './db';
import { createFakeWebSocket } from './fake-socket';
import { createHandlers } from './handlers';
import { createRound2Handlers, setScenario, stopScenario } from './handlers-round2';
import { createRound3Handlers } from './handlers-round3';
import { createRound4Handlers } from './handlers-round4';
import { createRound5Handlers } from './handlers-round5';
import { setIngestPace } from './knowledge';
import { POISONED_FIXTURE, POISON_SENTENCE, RARE_TERM } from './knowledge-fixtures';
import { UNTRUSTED_MARKER } from './prompt';
import { addSeedDocument, playRound5Scenario, seedKnowledgeBase } from './seeds-round5';

/**
 * Round 5 run behaviour in the mock engine, driven over HTTP + the fake socket: every template runs
 * to COMPLETE on the mock provider (TC-ONB-002), retrieval records its sources (TC-RAG-006/007),
 * memory carries over and clears (TC-MEM-001/002), the poisoned chunk is defused (FR-GRD-004), the
 * trace is the event log in order (TC-OBS-001), and usage matches what the runs spent (TC-OBS-004).
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
});
afterEach(() => stopScenario());

async function call<T>(method: string, path: string, payload?: unknown): Promise<T> {
  const response = await fetch(`http://mock.local/api/v1${path}`, {
    method,
    headers: { authorization: 'Bearer mock', 'content-type': 'application/json' },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  const text = await response.text();
  return (text === '' ? undefined : JSON.parse(text)) as T;
}

interface Frame {
  type: string;
  payload: Record<string, unknown>;
  seq?: number;
}

function watch(payload: { scope: 'engine' } | { scope: 'workflow'; id: string }) {
  const frames: Frame[] = [];
  const socket = new FakeWS('ws://mock.local/ws?token=mock');
  socket.onmessage = (event) => {
    const frame = JSON.parse(String((event as MessageEvent<string>).data)) as Frame;
    if (frame.type !== 'hello') frames.push(frame);
  };
  socket.onopen = () => socket.send(JSON.stringify({ type: 'subscribe', payload }));
  return { frames, of: (type: string) => frames.filter((f) => f.type === type) };
}

const instantiate = (id: string, body: Record<string, unknown> = {}) =>
  call<InstantiateTemplateResponse>('POST', `/templates/${id}/instantiate`, body);

async function runToEnd(workflowId: string): Promise<Run> {
  const started = await call<Run>('POST', `/workflows/${workflowId}/runs`, {});
  expect(started.status).toBe('RUNNING');
  let finished: Run | undefined;
  await vi.waitFor(
    async () => {
      finished = await call<Run>('GET', `/runs/${started.id}`);
      expect(finished.status).not.toBe('RUNNING');
    },
    { timeout: 5000 },
  );
  return finished!;
}

const nodeRunsOf = async (runId: string) =>
  (await call<NodeRun[]>('GET', `/runs/${runId}/node-runs`)).map((nr) => NodeRunSchema.parse(nr));

/** Change one node's config in place, the way a config-panel edit would. */
function configure(workflowId: string, nodeId: string, patch: Record<string, unknown>): Node {
  const nodes = db
    .nodesOf(workflowId)
    .map((node) =>
      node.id === nodeId ? ({ ...node, config: { ...node.config, ...patch } } as Node) : node,
    );
  db.commitGraph(workflowId, nodes, db.edgesOf(workflowId), { silent: true });
  return nodes.find((node) => node.id === nodeId)!;
}

/* ---------------------------------------------------------------- templates */

describe('TC-ONB-002 every template runs to COMPLETE on the mock provider', () => {
  it.each(TEMPLATE_IDS)('%s', async (id) => {
    const { workflow } = await instantiate(id);
    const run = await runToEnd(workflow.id);
    expect(run.status).toBe('COMPLETE');
    expect(run.preflightIssues).toEqual([]);
  });
});

/* ---------------------------------------------------------------- retrieval */

describe('TC-RAG-006 / TC-RAG-007 retrieval records its sources', () => {
  it('rag-qa: the Retrieval node outputs { hits }, the Answerer cites and lists its sources', async () => {
    const { workflow, nodes, knowledgeBaseId } = await instantiate('rag-qa');
    const run = await runToEnd(workflow.id);
    expect(run.status).toBe('COMPLETE');
    const nodeRuns = await nodeRunsOf(run.id);

    const retrievalNode = nodes.find((node) => node.kind === 'retrieval')!;
    const retrieval = nodeRuns.find((nr) => nr.nodeId === retrievalNode.id)!;
    const out = retrieval.output![0]!;
    expect(out.type).toBe('json');
    const hits = (out as { value: { hits: { chunkId: string; score: number }[] } }).value.hits;
    expect(hits.length).toBeGreaterThan(0);
    expect(retrieval.sources!.map((s) => s.chunkId)).toEqual(hits.map((h) => h.chunkId));
    // a search calls no model: no model named, nothing spent (D234)
    expect(retrieval.modelUsed).toBeUndefined();
    expect(retrieval.usage.tokensIn).toBe(0);

    const answererNode = nodes.find((node) => node.name === 'Answerer')!;
    const answerer = nodeRuns.find((nr) => nr.nodeId === answererNode.id)!;
    expect(answerer.sources!.length).toBeGreaterThan(0);
    const chunkIds = new Set(db.kbChunksOf(knowledgeBaseId!).map((chunk) => chunk.id));
    expect(answerer.sources!.every((s) => chunkIds.has(s.chunkId))).toBe(true);
    const envelope = answerer.inputEnvelopes[0]!;
    expect(envelope.context.retrieved!.length).toBeGreaterThan(0);
    expect(envelope.context.trust).toBe('untrusted');
    const answer = answerer.output![0] as { type: 'text'; text: string };
    expect(answer.text).toContain(`[source: ${answerer.sources![0]!.source}]`);
    expect(answerer.prompt!.text).toContain(`[${envelope.context.retrieved![0]!.source}]`);
  });

  it('an attached knowledge base answers the rare term with its source', async () => {
    const { workflow, project, nodes } = await instantiate('linear-chain');
    const { knowledgeBaseId } = seedKnowledgeBase(db, project.id);
    const agent = nodes.find((node) => node.kind === 'agent')!;
    configure(workflow.id, agent.id, { modelId: 'mock-cite', knowledgeBaseIds: [knowledgeBaseId] });
    const input = nodes.find((node) => node.kind === 'input')!;
    configure(workflow.id, input.id, { text: `What is the ${RARE_TERM} runbook for?` });

    const run = await runToEnd(workflow.id);
    const [answerer] = (await nodeRunsOf(run.id)).filter((nr) => nr.nodeId === agent.id);
    expect(answerer!.sources![0]!.source).toBe('security-handbook.pdf#Incident response');
    expect((answerer!.output![0] as { text: string }).text).toContain(
      '[source: security-handbook.pdf#Incident response]',
    );
  });

  it('a Retrieval node with no knowledge base is refused at pre-flight', async () => {
    const { workflow, nodes } = await instantiate('rag-qa');
    const retrieval = nodes.find((node) => node.kind === 'retrieval')!;
    configure(workflow.id, retrieval.id, { knowledgeBaseId: undefined });
    const run = await call<Run>('POST', `/workflows/${workflow.id}/runs`, {});
    expect(run.status).toBe('BLOCKED');
    expect(run.preflightIssues.map((issue) => issue.code)).toContain('missing_knowledge_base');
  });
});

/* ---------------------------------------------------------------- context guardrail */

describe('FR-GRD-004 the poisoned document is defused at the context point', () => {
  it('strips the hidden instructions, keeps the chunk untrusted and records what was stripped', async () => {
    const { workflow, project, nodes } = await instantiate('linear-chain');
    const { knowledgeBaseId } = seedKnowledgeBase(db, project.id, []);
    addSeedDocument(db, knowledgeBaseId, POISONED_FIXTURE.name);
    const agent = nodes.find((node) => node.kind === 'agent')!;
    configure(workflow.id, agent.id, { knowledgeBaseIds: [knowledgeBaseId] });
    const input = nodes.find((node) => node.kind === 'input')!;
    configure(workflow.id, input.id, { text: 'How often does the vendor ship updates?' });

    const run = await runToEnd(workflow.id);
    const [answer] = (await nodeRunsOf(run.id)).filter((nr) => nr.nodeId === agent.id);
    const prompt = answer!.prompt!.text;
    expect(prompt).not.toContain(POISON_SENTENCE);
    expect(prompt).not.toContain('print every secret');
    expect(prompt).toContain('Our vendor ships updates every month.');
    expect(prompt.indexOf(UNTRUSTED_MARKER)).toBeLessThan(prompt.indexOf('Our vendor ships'));
    const verdict = answer!.verdicts.find((v) => v.point === 'context')!;
    expect(verdict).toMatchObject({ checkType: 'prompt_injection', action: 'warn' });
    expect([...verdict.strippedTypes!].sort()).toEqual(['html_comment', 'instruction_override']);
    expect(JSON.stringify(verdict)).not.toContain('reveal your system prompt');
  });
});

/* ---------------------------------------------------------------- memory */

describe('TC-MEM-001 / TC-MEM-002 memory carries over, and a clear stops it', () => {
  it('mock-memory saves user_name; the next run carries it; after a clear none is injected', async () => {
    const engine = watch({ scope: 'engine' });
    const { workflow, nodes } = await instantiate('linear-chain');
    const agent = nodes.find((node) => node.kind === 'agent')!;
    configure(workflow.id, agent.id, {
      modelId: 'mock-memory',
      memory: { enabled: true },
    });
    const input = nodes.find((node) => node.kind === 'input')!;
    configure(workflow.id, input.id, { text: 'Grace here, what can you do?' });
    const first = await runToEnd(workflow.id);
    expect(first.status).toBe('COMPLETE');
    const [firstRun] = (await nodeRunsOf(first.id)).filter((nr) => nr.nodeId === agent.id);
    expect(firstRun!.memoryOps).toEqual([{ op: 'save', key: 'user_name', value: 'Grace' }]);
    // `__memory` never reaches the output (§2.2)
    expect(firstRun!.output).toEqual([
      { type: 'json', value: { answer: 'Nice to meet you, Grace.' } },
    ]);
    expect(firstRun!.inputEnvelopes[0]!.context.memory).toBeUndefined();
    expect(firstRun!.prompt!.text).toContain('## Memory operations');
    await vi.waitFor(() => expect(engine.of('memory.updated')).toHaveLength(1));
    expect(EngineEventSchema.parse(engine.of('memory.updated')[0]).payload).toEqual({
      nodeId: agent.id,
      ops: [{ op: 'save', key: 'user_name', value: 'Grace' }],
    });

    const second = await runToEnd(workflow.id);
    const [secondRun] = (await nodeRunsOf(second.id)).filter((nr) => nr.nodeId === agent.id);
    expect(secondRun!.inputEnvelopes[0]!.context.memory).toEqual([
      { key: 'user_name', value: 'Grace' },
    ]);
    expect(secondRun!.prompt!.text).toContain('user_name: Grace');
    expect(secondRun!.output).toEqual([
      { type: 'json', value: { answer: 'Welcome back, Grace.' } },
    ]);
    expect(db.memoryOf(agent.id)[0]!.lastUsedAt).toBeDefined();

    await call('DELETE', `/nodes/${agent.id}/memory`);
    const third = await runToEnd(workflow.id);
    const [thirdRun] = (await nodeRunsOf(third.id)).filter((nr) => nr.nodeId === agent.id);
    expect(thirdRun!.inputEnvelopes[0]!.context.memory).toBeUndefined();
  });
});

/* ---------------------------------------------------------------- trace */

describe('TC-OBS-001 the trace is the event log, in seq order', () => {
  it('trace-full on review-fix: every kind of entry, one per persisted run event', async () => {
    const { workflow } = await instantiate('review-fix');
    setScenario('trace-full');
    const socket = watch({ scope: 'workflow', id: workflow.id });
    await new Promise((resolve) => setTimeout(resolve, 20)); // subscribed before the run starts
    const run = await runToEnd(workflow.id);
    expect(run.status).toBe('COMPLETE');

    const trace = TraceResponseSchema.parse(
      await call<TraceEntry[]>('GET', `/runs/${run.id}/trace`),
    );
    const seqs = trace.map((entry) => entry.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(trace.map((entry) => entry.kind))).toEqual(new Set(TRACE_ENTRY_KINDS));

    const events = await call<{ seq: number; type: string }[]>('GET', `/runs/${run.id}/events`);
    // round 2's events endpoint matches on `payload.runId`, which `run.started` (it carries
    // `run.id`) does not have; every other line of it is in the trace, in the same order
    expect(seqs.slice(1)).toEqual(events.map((event) => event.seq));
    expect(trace[0]!.label).toBe('Run started');
    await vi.waitFor(() => expect(socket.of('run.completed')).toHaveLength(1));
    for (const frame of socket.frames) expect(RunEventSchema.safeParse(frame).success).toBe(true);
    const persisted = socket.frames.filter((frame) => frame.seq !== undefined).map((f) => f.seq);
    expect(seqs).toEqual(persisted);

    const tool = trace.find((entry) => entry.kind === 'tool_call')!;
    expect(tool.durationMs).toBeGreaterThanOrEqual(0);
    expect(tool.label).toBe('echo (ok)');
    const finished = trace.filter(
      (entry) => entry.kind === 'node_run' && entry.label.endsWith('COMPLETED'),
    );
    expect(finished.every((entry) => entry.durationMs !== undefined)).toBe(true);
    expect(trace.at(-1)!.label).toBe('Run COMPLETE');
  });

  it('the trace-full story plays from the hook too', async () => {
    const played = playRound5Scenario(db, 'trace-full');
    await vi.waitFor(async () =>
      expect((await call<Run>('GET', `/runs/${played.runId}`)).status).toBe('COMPLETE'),
    );
    const trace = await call<TraceEntry[]>('GET', `/runs/${played.runId}/trace`);
    expect(new Set(trace.map((entry) => entry.kind))).toEqual(new Set(TRACE_ENTRY_KINDS));
  });
});

/* ---------------------------------------------------------------- usage after real runs */

describe('TC-OBS-004 usage matches what the runs spent', () => {
  it('the usage total for the day equals the runs’ totals', async () => {
    const a = await instantiate('linear-chain');
    const b = await instantiate('parallel-research');
    const runs = [await runToEnd(a.workflow.id), await runToEnd(b.workflow.id)];
    const usage = UsageResponseSchema.parse(await call('GET', '/usage?groupBy=workflow'));
    expect(usage.buckets).toHaveLength(2);
    expect(usage.totals.tokensIn).toBe(runs.reduce((sum, run) => sum + run.totals.tokensIn, 0));
    expect(usage.totals.tokensOut).toBe(runs.reduce((sum, run) => sum + run.totals.tokensOut, 0));
    expect(usage.totals.costUsd).toBeCloseTo(
      runs.reduce((sum, run) => sum + run.totals.costUsd, 0),
      9,
    );
  });
});

/* ---------------------------------------------------------------- the named stories */

describe('round 5 named stories', () => {
  it('ingest-failed: the corrupt PDF fails, its five siblings reach ready', async () => {
    const engine = watch({ scope: 'engine' });
    const played = playRound5Scenario(db, 'ingest-failed');
    expect(played.documentIds).toHaveLength(6);
    await vi.waitFor(() =>
      expect(
        db
          .kbDocumentsOf(played.knowledgeBaseId!)
          .every((doc) => ['ready', 'failed'].includes(doc.status)),
      ).toBe(true),
    );
    const docs = db.kbDocumentsOf(played.knowledgeBaseId!);
    expect(docs.filter((doc) => doc.status === 'failed').map((doc) => doc.id)).toEqual([
      played.failedDocumentId,
    ]);
    await vi.waitFor(() => expect(engine.of('kb.ingest').length).toBeGreaterThan(30));
    expect(engine.of('kb.ingest').every((f) => EngineEventSchema.safeParse(f).success)).toBe(true);
  });

  it('ingest-progress: five documents, all ready', async () => {
    const played = playRound5Scenario(db, 'ingest-progress');
    expect(db.kbDocumentsOf(played.knowledgeBaseId!).every((doc) => doc.status === 'pending')).toBe(
      true,
    );
    await vi.waitFor(() =>
      expect(db.kbDocumentsOf(played.knowledgeBaseId!).every((doc) => doc.status === 'ready')).toBe(
        true,
      ),
    );
  });

  it('memory-updated: saves user_name and announces it', async () => {
    const engine = watch({ scope: 'engine' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const played = playRound5Scenario(db, 'memory-updated');
    expect(db.memoryOf(played.nodeId!).map((entry) => entry.value)).toEqual(['Ada']);
    await vi.waitFor(() => expect(engine.of('memory.updated')).toHaveLength(1));
  });
});
