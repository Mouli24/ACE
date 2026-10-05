import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ARTIFACT_UPLOAD_FIELD,
  FORMAT_VERSION,
  derivePorts,
  ArtifactSchema,
  KbDocumentSchema,
  KnowledgeBaseSchema,
  NodeRunSchema,
  ProjectSchema,
  ProviderSchema,
  RunSchema,
  WorkflowGraphResponseSchema,
  isKbDocumentSettled,
  type Artifact,
  type Edge,
  type KbDocument,
  type KnowledgeBase,
  type Node,
  type NodeRun,
  type Run,
  type StartRunRequest,
  type WorkflowExport,
  type WorkflowGraphResponse,
} from '@ace/contracts';
import { newId } from '@ace/engine';
import { createMockAdapter, type MockProviderAdapter } from '@ace/providers';
import { expect } from 'vitest';

import { startEngine, type RunningEngine } from '../server.js';

/**
 * The round 5 end-to-end harness (Task 13b): the real engine from `startEngine`, a temp data dir,
 * the mock provider — with its call log reachable through the injected adapter — and the round 5
 * fixtures with their placeholders rewritten (`tests/acceptance/fixtures/round-5/README.md`).
 *
 * Every wait polls against a deadline and fails with what it was waiting for: nothing here can hang
 * a suite, a stuck ingestion or run included.
 */

export const FIXTURES = fileURLToPath(
  new URL('../../../../tests/acceptance/fixtures/round-5/', import.meta.url),
);
export const CORPUS = join(FIXTURES, 'corpus');

/** The placeholders the round 5 fixtures carry (README, "The placeholders a harness rewrites"). */
export const PLACEHOLDER = {
  provider: '01M5R5PV0000000000000000PV',
  knowledgeBase: '01M5R5KB0000000000000000KB',
  policy: '01M5R5PC0000000000000000PC',
  project: '01M5R5PJ0000000000000000PJ',
} as const;

/** The media type each corpus file is uploaded with — what a browser would send. */
export const CORPUS_MIME: Readonly<Record<string, string>> = {
  'handbook.md': 'text/markdown',
  'onboarding.pdf': 'application/pdf',
  'policies.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'faq.html': 'text/html',
  'retry.ts': 'text/plain',
  'notes.txt': 'text/plain',
  'corrupt.pdf': 'application/pdf',
  'poisoned.md': 'text/markdown',
  'pii.txt': 'text/plain',
};

/** The six document types of FR-RAG-002, one corpus file each. */
export const SIX_TYPES = [
  'handbook.md',
  'onboarding.pdf',
  'policies.docx',
  'faq.html',
  'retry.ts',
  'notes.txt',
] as const;

export interface Question {
  kind: 'exact' | 'paraphrase';
  question: string;
  expectedSource: string;
}

export const QUESTIONS = JSON.parse(
  readFileSync(join(FIXTURES, 'questions.json'), 'utf8'),
) as Question[];

const DEFAULT_DEADLINE_MS = 30_000;

/** Polls `probe` until it answers something, or fails naming what never happened. */
export async function until<T>(
  what: string,
  probe: () => Promise<T | undefined>,
  timeoutMs = DEFAULT_DEADLINE_MS,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await probe();
    if (found !== undefined) return found;
    if (Date.now() > deadline)
      throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export interface Round5Engine {
  engine: RunningEngine;
  dir: string;
  /** The adapter every mock provider row shares, so its `calls()` spans the whole engine. */
  mock: MockProviderAdapter;
  /** A raw request with the session token. */
  api(path: string, init?: RequestInit): Promise<Response>;
  /** A request that must succeed (< 300); answers the parsed JSON body. */
  ok(path: string, init?: RequestInit): Promise<unknown>;
  get(path: string): Promise<unknown>;
  post(path: string, body?: unknown): Promise<unknown>;
  /** Stops the engine; removes the data dir unless it was handed in. */
  stop(): Promise<void>;
}

export async function startRound5Engine(
  options: { dataDir?: string; mock?: MockProviderAdapter; clock?: () => string } = {},
): Promise<Round5Engine> {
  const dir = options.dataDir ?? mkdtempSync(join(tmpdir(), 'ace-r5-'));
  const mock = options.mock ?? createMockAdapter();
  const engine = await startEngine({
    dataDir: dir,
    port: 0,
    env: {},
    mockProvider: mock,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });

  const api = (path: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${engine.url}/api/v1${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${engine.token}`, ...init.headers },
    });

  const ok = async (path: string, init: RequestInit = {}): Promise<unknown> => {
    const response = await api(path, init);
    const text = await response.text();
    expect(response.status, `${init.method ?? 'GET'} ${path}: ${text}`).toBeLessThan(300);
    return text === '' ? undefined : (JSON.parse(text) as unknown);
  };

  return {
    engine,
    dir,
    mock,
    api,
    ok,
    get: (path) => ok(path),
    post: (path, body = {}) =>
      ok(path, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
      }),
    async stop() {
      await engine.stop();
      if (options.dataDir !== undefined) return;
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Windows can still hold the SQLite WAL handle for a moment; the OS reclaims temp itself.
      }
    },
  };
}

/** A mock provider with its catalogue refreshed, so a run can route to its models. */
export async function mockProvider(e: Round5Engine, body: Record<string, unknown> = {}) {
  const provider = ProviderSchema.parse(
    await e.post('/providers', { type: 'mock', name: 'Mock', ...body }),
  );
  await e.post(`/providers/${provider.id}/refresh-models`);
  return provider.id;
}

export async function createProject(e: Round5Engine, name: string): Promise<string> {
  return ProjectSchema.parse(await e.post('/projects', { name })).id;
}

export async function upload(
  e: Round5Engine,
  name: string,
  bytes: Uint8Array,
  mime: string,
): Promise<Artifact> {
  const form = new FormData();
  form.append(ARTIFACT_UPLOAD_FIELD, new File([bytes], name, { type: mime }));
  return ArtifactSchema.parse(await e.ok('/artifacts', { method: 'POST', body: form }));
}

export const corpusBytes = (file: string): Uint8Array =>
  new Uint8Array(readFileSync(join(CORPUS, file)));

export async function createKb(
  e: Round5Engine,
  projectId: string,
  providerId: string,
  body: Record<string, unknown> = {},
): Promise<KnowledgeBase> {
  return KnowledgeBaseSchema.parse(
    await e.post(`/projects/${projectId}/knowledge-bases`, {
      name: 'Corpus',
      embeddingProviderId: providerId,
      embeddingModelId: 'mock-embed',
      ...body,
    }),
  );
}

/** Uploads one file and adds it to the base: 202, `pending`. */
export async function addFile(
  e: Round5Engine,
  kbId: string,
  name: string,
  bytes: Uint8Array,
  mime: string,
): Promise<KbDocument> {
  const artifact = await upload(e, name, bytes, mime);
  const response = await e.api(`/knowledge-bases/${kbId}/documents`, {
    method: 'POST',
    body: JSON.stringify({ artifactId: artifact.id }),
    headers: { 'Content-Type': 'application/json' },
  });
  expect(response.status, await response.clone().text()).toBe(202);
  return KbDocumentSchema.parse(await response.json());
}

export const addCorpusFile = (e: Round5Engine, kbId: string, file: string): Promise<KbDocument> =>
  addFile(e, kbId, file, corpusBytes(file), CORPUS_MIME[file] ?? 'text/plain');

export async function listDocuments(e: Round5Engine, kbId: string): Promise<KbDocument[]> {
  const { items } = (await e.get(`/knowledge-bases/${kbId}/documents`)) as { items: unknown[] };
  return items.map((item) => KbDocumentSchema.parse(item));
}

/** Waits until every document of the base is `ready` or `failed` (Arch §21.3). */
export async function settledDocuments(
  e: Round5Engine,
  kbId: string,
  count: number,
): Promise<KbDocument[]> {
  return until(`${count} documents of ${kbId} to settle`, async () => {
    const docs = await listDocuments(e, kbId);
    return docs.length === count && docs.every((doc) => isKbDocumentSettled(doc.status))
      ? docs
      : undefined;
  });
}

/** Reads a fixture workflow with its placeholders rewritten. */
export function fixtureWorkflow(file: string, rewrites: Record<string, string>): WorkflowExport {
  let text = readFileSync(join(FIXTURES, file), 'utf8');
  for (const [from, to] of Object.entries(rewrites)) text = text.replaceAll(from, to);
  return JSON.parse(text) as WorkflowExport;
}

export async function importWorkflow(
  e: Round5Engine,
  projectId: string,
  workflow: WorkflowExport,
): Promise<WorkflowGraphResponse> {
  return WorkflowGraphResponseSchema.parse(
    await e.post(`/projects/${projectId}/workflows/import`, workflow),
  );
}

const UNFINISHED: ReadonlySet<string> = new Set(['PREFLIGHT', 'RUNNING', 'PAUSED']);

/** Starts a run and waits for it to end (COMPLETE, HALTED or BLOCKED). */
export async function runToEnd(
  e: Round5Engine,
  workflowId: string,
  request: StartRunRequest = {},
): Promise<Run> {
  const started = RunSchema.parse(await e.post(`/workflows/${workflowId}/runs`, request));
  return until(`run ${started.id} to end`, async () => {
    const run = RunSchema.parse(await e.get(`/runs/${started.id}`));
    return UNFINISHED.has(run.status) ? undefined : run;
  });
}

export async function nodeRunsOf(e: Round5Engine, runId: string): Promise<NodeRun[]> {
  return NodeRunSchema.array().parse(await e.get(`/runs/${runId}/node-runs`));
}

/** The latest node run of one node in a run. */
export async function nodeRunOf(e: Round5Engine, runId: string, nodeId: string): Promise<NodeRun> {
  const row = (await nodeRunsOf(e, runId)).filter((each) => each.nodeId === nodeId).at(-1);
  if (row === undefined) throw new Error(`run ${runId} has no node run for ${nodeId}`);
  return row;
}

/** Every run this engine recorded, across every project and workflow. */
export async function everyRun(e: Round5Engine): Promise<Run[]> {
  const runs: Run[] = [];
  const { items: projects } = (await e.get('/projects?limit=500')) as { items: { id: string }[] };
  for (const project of projects) {
    const { items: workflows } = (await e.get(`/projects/${project.id}/workflows?limit=500`)) as {
      items: { id: string }[];
    };
    for (const workflow of workflows) {
      const { items } = (await e.get(`/workflows/${workflow.id}/runs?limit=500`)) as {
        items: { id: string }[];
      };
      for (const summary of items) runs.push(RunSchema.parse(await e.get(`/runs/${summary.id}`)));
    }
  }
  return runs;
}

/** A graph built in the test, imported like any workflow export (D100: fresh ids, ports derived). */
export function graphBuilder(name: string) {
  const workflowId = newId();
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  return {
    nodes,
    /** A node of `kind` with `config` as given; its ports are derived from it. */
    add(kind: Node['kind'], label: string, config: Record<string, unknown>): Node {
      const draft = {
        id: newId(),
        workflowId,
        kind,
        name: label,
        position: { x: nodes.length * 320, y: 80 },
        config,
      };
      const node = { ...draft, ...derivePorts(draft as Parameters<typeof derivePorts>[0]) } as Node;
      nodes.push(node);
      return node;
    },
    /** A data edge from `from`'s first output to `to`'s input of the same type. */
    connect(from: Node, to: Node): void {
      const out = from.outputs[0];
      const into = to.inputs.find((port) => port.dataType === out?.dataType) ?? to.inputs[0];
      if (out === undefined || into === undefined) throw new Error(`cannot connect ${from.name}`);
      edges.push({
        id: newId(),
        workflowId,
        kind: 'data',
        from: { nodeId: from.id, portId: out.id },
        to: { nodeId: to.id, portId: into.id },
      });
    },
    export(): WorkflowExport {
      return {
        formatVersion: FORMAT_VERSION,
        exportedAt: new Date().toISOString(),
        name,
        nodes,
        edges,
      };
    },
  };
}
