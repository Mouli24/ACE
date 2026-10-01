import {
  DEFAULT_CHUNK_OVERLAP,
  DEFAULT_CHUNK_SIZE,
  allowedRunActions,
  type KbDocument,
  type KnowledgeBase,
  type MemoryEntry,
  type Node,
  type NodeRun,
  type Run,
  type Usage,
} from '@ace/contracts';

import { newId } from '../lib/ulid';
import { createNode } from '../nodes/factory';
import { MOCK_EMBED_MODEL_ID, MOCK_PRICING } from './catalog';
import type { MockDb } from './db';
import { currentScenario, playScenario, preflight, setScenario } from './handlers-round2';
import { addDocument, ingestNow, startIngestion } from './knowledge';
import {
  CORRUPT_PDF_FIXTURE,
  KB_FIXTURES,
  POISONED_FIXTURE,
  SAMPLE_DOCUMENT_FIXTURE,
  type KbFixture,
} from './knowledge-fixtures';
import { applyMemoryOps } from './round5-run';
import { instantiateTemplate, mockProviderOf } from './templates';

/**
 * Round 5 seeds and stories for the mock engine (§1, §2.9): what `window.__aceMock` exposes so a
 * Playwright test or a demo can land on a knowledge base, a memory, a usage history or a full trace
 * without walking the UI there first. Each also works in a unit test against a bare `MockDb`.
 */

/** A document to seed: a fixture by name, or text of your own. */
export type SeedDocument = string | { name: string; mime?: string; text: string };

const ALL_FIXTURES: readonly KbFixture[] = [
  ...KB_FIXTURES,
  CORRUPT_PDF_FIXTURE,
  POISONED_FIXTURE,
  SAMPLE_DOCUMENT_FIXTURE,
];

function fixtureFor(doc: SeedDocument): KbFixture {
  if (typeof doc !== 'string') {
    const bytes = new TextEncoder().encode(doc.text);
    return { name: doc.name, mime: doc.mime ?? 'text/plain', bytes: () => bytes };
  }
  const fixture = ALL_FIXTURES.find((candidate) => candidate.name === doc);
  if (fixture === undefined) throw new Error(`no knowledge fixture named "${doc}"`);
  return fixture;
}

/** A new, empty knowledge base on the mock embedder. */
export function createMockKnowledgeBase(
  db: MockDb,
  projectId: string,
  name = 'Team handbook',
): KnowledgeBase {
  const provider = mockProviderOf(db);
  const ts = new Date().toISOString();
  return db.addKnowledgeBase({
    id: newId(),
    projectId,
    name,
    embeddingProviderId: provider.id,
    embeddingModelId: MOCK_EMBED_MODEL_ID,
    chunkSize: DEFAULT_CHUNK_SIZE,
    chunkOverlap: DEFAULT_CHUNK_OVERLAP,
    documentCount: 0,
    chunkCount: 0,
    createdAt: ts,
    updatedAt: ts,
  });
}

/** Upload one document and ingest it: at once (`ready` or `failed` now), or staged at the pace. */
export function addSeedDocument(
  db: MockDb,
  knowledgeBaseId: string,
  doc: SeedDocument,
  staged = false,
): KbDocument {
  const fixture = fixtureFor(doc);
  const artifact = db.putArtifact({
    mime: fixture.mime,
    name: fixture.name,
    bytes: fixture.bytes(),
  });
  const row = addDocument(db, knowledgeBaseId, artifact);
  if (staged) {
    startIngestion(db, row.id);
    return row;
  }
  return ingestNow(db, row);
}

/**
 * A knowledge base in this project (or a new "Knowledge" project) holding these documents —
 * every good fixture by default — already ingested unless `staged`.
 */
export function seedKnowledgeBase(
  db: MockDb,
  projectId?: string,
  docs: readonly SeedDocument[] = KB_FIXTURES.map((fixture) => fixture.name),
  options: { name?: string; staged?: boolean } = {},
): { projectId: string; knowledgeBaseId: string; documentIds: string[] } {
  const project =
    (projectId === undefined ? undefined : db.getProject(projectId)) ??
    db.createProject({ name: 'Knowledge' });
  const kb = createMockKnowledgeBase(db, project.id, options.name);
  const documentIds = docs.map((doc) => addSeedDocument(db, kb.id, doc, options.staged).id);
  return { projectId: project.id, knowledgeBaseId: kb.id, documentIds };
}

/** Remember these facts for a node, announced as one `memory.updated` (D230). */
export function seedMemory(
  db: MockDb,
  nodeId: string,
  entries: readonly { key: string; value: string }[],
): MemoryEntry[] {
  applyMemoryOps(
    db,
    nodeId,
    entries.map((entry) => ({ op: 'save' as const, key: entry.key, value: entry.value })),
  );
  return db.memoryOf(nodeId);
}

/* -------------------------------------------------------------------------- */
/* Usage history (FR-OBS-004)                                                  */
/* -------------------------------------------------------------------------- */

const priced = (tokensIn: number, tokensOut: number): Usage => ({
  tokensIn,
  tokensOut,
  costUsd: Number(
    (
      (tokensIn / 1000) * MOCK_PRICING.inputPer1k +
      (tokensOut / 1000) * MOCK_PRICING.outputPer1k
    ).toFixed(6),
  ),
  priceTableVersion: MOCK_PRICING.priceTableVersion,
});

/**
 * `days` days of finished runs, one a day on the mock provider and one every other day on a seeded
 * Anthropic provider, each node run dated that day at 10:00 UTC — so the usage screen has something
 * to break down by provider, model, day and workflow. Answers what it created.
 */
export function seedUsage(
  db: MockDb,
  days = 7,
): { projectId: string; workflowId: string; runIds: string[]; providerIds: string[] } {
  const project = db.createProject({ name: 'Usage history' });
  const workflow = db.createWorkflow(project.id, 'Daily digest');
  const mock = mockProviderOf(db);
  const cloud =
    db.listProviders().find((provider) => provider.type === 'anthropic') ??
    db.createProvider({ type: 'anthropic', name: 'Anthropic', apiKey: 'seeded-not-a-key' });

  const inputNode = createNode('input', workflow.id, { x: 80, y: 140 });
  const agentNode = createNode('agent', workflow.id, { x: 400, y: 140 });
  const outputNode = createNode('output', workflow.id, { x: 720, y: 140 });
  const nodes: Node[] = [inputNode, agentNode, outputNode];
  const committed = db.commitGraph(workflow.id, nodes, [], { silent: true });

  const today = new Date();
  const runIds: string[] = [];
  for (let back = days - 1; back >= 0; back -= 1) {
    const day = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - back, 10),
    );
    const choices: { providerId: string; modelId: string }[] = [
      { providerId: mock.id, modelId: 'mock-text' },
      ...(back % 2 === 0 ? [{ providerId: cloud.id, modelId: 'claude-haiku-4-5' }] : []),
    ];
    choices.forEach((choice, i) => {
      const startedAt = new Date(day.getTime() + i * 60_000).toISOString();
      const endedAt = new Date(day.getTime() + i * 60_000 + 900).toISOString();
      const spent = priced(100 + back * 10 + i * 40, 50 + back * 5 + i * 20);
      const run: Run = {
        id: newId(),
        workflowId: workflow.id,
        projectId: project.id,
        status: 'COMPLETE',
        snapshot: { version: committed.version, nodes, edges: [] },
        inputs: {},
        preflightIssues: [],
        totals: spent,
        startedAt,
        endedAt,
        durationMs: 900,
        allowedActions: allowedRunActions('COMPLETE'),
      };
      const nodeRun: NodeRun = {
        id: newId(),
        runId: run.id,
        nodeId: agentNode.id,
        iteration: 1,
        attempt: 1,
        status: 'COMPLETED',
        modelUsed: { ...choice, viaFallback: false },
        inputEnvelopes: [],
        output: [{ type: 'text', text: 'digest' }],
        usage: spent,
        verdicts: [],
        toolCalls: [],
        startedAt,
        endedAt,
        durationMs: 600 + back * 50 + i * 200,
      };
      db.addRun(run);
      db.upsertNodeRun(nodeRun);
      runIds.push(run.id);
    });
  }
  return {
    projectId: project.id,
    workflowId: workflow.id,
    runIds,
    providerIds: [mock.id, cloud.id],
  };
}

/* -------------------------------------------------------------------------- */
/* Named stories (round 5 §3: ingest-progress, ingest-failed, memory-updated, trace-full) */
/* -------------------------------------------------------------------------- */

export type Round5Scenario = 'ingest-progress' | 'ingest-failed' | 'memory-updated' | 'trace-full';

export interface Round5ScenarioResult {
  projectId?: string;
  knowledgeBaseId?: string;
  documentIds?: string[];
  /** `ingest-failed`: the corrupt document, among its five good siblings. */
  failedDocumentId?: string;
  nodeId?: string;
  workflowId?: string;
  runId?: string;
}

/**
 * Play one of round 5's named stories:
 * - `ingest-progress` — a new base takes the five good fixtures, each streaming `kb.ingest` through
 *   parsing → chunking → embedding (progress climbing) → ready at the ingest pace;
 * - `ingest-failed` — the same plus the corrupt PDF, which fails at `parsing` with a reason while
 *   its siblings reach `ready` (TC-RAG-003);
 * - `memory-updated` — `user_name` is saved for `options.nodeId` (or a new memory agent) and
 *   announced as `memory.updated`;
 * - `trace-full` — the `review-fix` template runs the `trace-full` script, so its trace holds every
 *   kind of entry (TC-OBS-001).
 */
export function playRound5Scenario(
  db: MockDb,
  name: Round5Scenario,
  options: { projectId?: string; nodeId?: string } = {},
): Round5ScenarioResult {
  switch (name) {
    case 'ingest-progress':
    case 'ingest-failed': {
      const docs: SeedDocument[] = KB_FIXTURES.slice(0, 5).map((fixture) => fixture.name);
      if (name === 'ingest-failed') docs.splice(2, 0, CORRUPT_PDF_FIXTURE.name);
      const seeded = seedKnowledgeBase(db, options.projectId, docs, { staged: true });
      return {
        ...seeded,
        ...(name === 'ingest-failed' ? { failedDocumentId: seeded.documentIds[2]! } : {}),
      };
    }
    case 'memory-updated': {
      let nodeId = options.nodeId;
      if (nodeId === undefined) {
        const project = db.createProject({ name: 'Memory' });
        const workflow = db.createWorkflow(project.id, 'Remembering agent');
        const agentNode = createNode('agent', workflow.id, { x: 400, y: 140 });
        const node = {
          ...agentNode,
          config: {
            ...agentNode.config,
            providerId: mockProviderOf(db).id,
            modelId: 'mock-memory',
            memory: { enabled: true },
          },
        } as Node;
        db.commitGraph(workflow.id, [node], [], { silent: true });
        nodeId = node.id;
      }
      seedMemory(db, nodeId, [{ key: 'user_name', value: 'Ada' }]);
      return { nodeId };
    }
    case 'trace-full': {
      const outcome = instantiateTemplate(db, 'review-fix', {
        ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
      });
      if (!outcome.ok) throw new Error(`${outcome.what} not found`);
      const { project, workflow } = outcome.response;
      const nodes = db.nodesOf(workflow.id);
      const issues = preflight(
        nodes,
        db.listModels(),
        {},
        new Set(db.listProviders().map((provider) => provider.id)),
      );
      const run: Run = {
        id: newId(),
        workflowId: workflow.id,
        projectId: project.id,
        status: issues.length > 0 ? 'BLOCKED' : 'RUNNING',
        snapshot: { version: workflow.version, nodes, edges: db.edgesOf(workflow.id) },
        inputs: {},
        preflightIssues: issues,
        totals: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
        startedAt: new Date().toISOString(),
        allowedActions: allowedRunActions(issues.length > 0 ? 'BLOCKED' : 'RUNNING'),
      };
      db.addRun(run);
      if (issues.length === 0) {
        const previous = currentScenario();
        setScenario('trace-full');
        try {
          playScenario(db, run);
        } finally {
          setScenario(previous);
        }
      }
      return { projectId: project.id, workflowId: workflow.id, runId: run.id };
    }
  }
}
