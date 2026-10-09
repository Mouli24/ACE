import { derivePorts, type GuardrailCheckType } from '@ace/contracts';
import { setupWorker } from 'msw/browser';

import { MockDb } from './db';
import { seedPerfFixture } from './fixture';
import { createFakeWebSocket, dropMockSockets } from './fake-socket';
import { createHandlers } from './handlers';
import { createRound2Handlers, setScenario, setStreamPace } from './handlers-round2';
import { createRound3Handlers, decideApproval, requireApproval } from './handlers-round3';
import {
  createRound4Handlers,
  requireChatBlock,
  setChatScenario,
  type ChatScenario,
} from './handlers-round4';
import { createRound5Handlers } from './handlers-round5';
import { failNextIngest, setIngestPace } from './knowledge';
import {
  playRound5Scenario,
  seedKnowledgeBase,
  seedMemory,
  seedUsage,
  type Round5Scenario,
  type Round5ScenarioResult,
  type SeedDocument,
} from './seeds-round5';
import { createNode, type CanvasNodeKind } from '../nodes/factory';
import { applyOpsWithRules } from './graph-rules';

declare global {
  interface Window {
    /** Test hooks for Playwright (round 1 §5 step 10). */
    __aceMock?: {
      db: MockDb;
      /** Bump a workflow version without telling this tab, to force a 409 (TC-WF-005). */
      bumpVersion(workflowId: string): number;
      reset(): void;
      /** Delay every mock response by `ms` (persists across reloads) — TC-CAN-009. */
      setLatency(ms: number): void;
      /** Which scripted run scenario the next run plays (§5 item 11; round 4 adds its own). */
      setScenario(name: Parameters<typeof setScenario>[0]): void;
      /** Which story the next direct chat tells (round 4 §5.5): stream, input-blocked, reply-blocked. */
      setChatScenario(name: ChatScenario): void;
      /** Make the next chat input refuse regardless of its text (round 4 FR-CHAT-008/FR-GRD-022). */
      requireChatBlock(on?: boolean): void;
      /**
       * How fast the next run streams (persists across reloads, like the scenario). `slow` is
       * `mock-slow`'s pace against the real engine — what a test needs when it has to click a run
       * control while the run is still live (D200).
       */
      setStreamPace(pace: Parameters<typeof setStreamPace>[0]): void;
      /** Cut every open socket, as an engine restart would (TC-EXE-013). */
      dropSocket(): void;
      /** Announce a provider state change without a reload (FR-PRV-004, TC-PRV-005). */
      setProviderStatus(id: string, status: string, message?: string): void;
      /** Create a project + workflow with one node per kind, laid out left to right. */
      seedGraph(
        kinds: CanvasNodeKind[],
        options?: {
          projectName?: string;
          workflowName?: string;
          /** Put Agent/Model nodes on the mock provider's `mock-chat`, so they can chat (D287). */
          withModel?: boolean;
        },
      ): { projectId: string; workflowId: string; nodeIds: string[] };
      /**
       * Place one node of any kind — including the ones the New node dialog no longer offers (D285)
       * — the way a workflow made before then holds it. Announced, so an open Canvas refetches.
       */
      addNode(workflowId: string, kind: CanvasNodeKind, position: { x: number; y: number }): string;
      /** Patch one node's config and re-derive its ports — a legacy shape the UI cannot make (D285). */
      patchNodeConfig(workflowId: string, nodeId: string, patch: Record<string, unknown>): void;
      /**
       * A workflow a run can actually execute (round 2): Input → Agent → Output with the mock
       * provider chosen, so an e2e test can press Start without walking the config panel first.
       */
      seedRunnable(options?: { text?: string; modelId?: string; outputTypes?: string[] }): {
        projectId: string;
        workflowId: string;
        providerId: string;
        inputId: string;
        agentId: string;
        outputId: string;
        edgeIds: string[];
      };
      /**
       * Round 3: put a node run into WAITING with an approval card, without waiting for a scenario
       * to reach one (FR-GRD-013). Answers the request id, or undefined if there is no such run.
       */
      requireApproval(
        nodeRunId: string,
        options?: { checkType?: GuardrailCheckType; reason?: string; preview?: string },
      ): string | undefined;
      /** Round 3: decide a pending approval from a test, as the card's buttons would. */
      approve(nodeRunId: string, note?: string): boolean;
      reject(nodeRunId: string, note?: string): boolean;
      /** Round 3: the approval requests of a run that are still waiting for a decision. */
      pendingApprovals(runId: string): { id: string; nodeRunId: string; nodeName: string }[];
      /**
       * Round 5: how long each ingestion stage takes, in ms (persists across reloads). Lower it for a
       * fast test; raise it to watch the progress bar climb (FR-RAG-003).
       */
      setIngestPace(ms: number): void;
      /** Round 5: fail the next added document at `parsing`, whatever its bytes (FR-RAG-003). */
      failNextIngest(on?: boolean): void;
      /**
       * Round 5: a knowledge base on the mock embedder in this project (or a new one), holding these
       * documents — fixture names from `knowledge-fixtures.ts`, or `{ name, mime?, text }` — already
       * ingested unless `staged`. Every good fixture when `docs` is left out.
       */
      seedKnowledgeBase(
        projectId?: string,
        docs?: SeedDocument[],
        options?: { name?: string; staged?: boolean },
      ): { projectId: string; knowledgeBaseId: string; documentIds: string[] };
      /** Round 5: remember these facts for a node, announced as `memory.updated` (FR-MEM-001). */
      seedMemory(nodeId: string, entries: { key: string; value: string }[]): void;
      /** Round 5: `days` days of finished runs across two providers, for the usage screen. */
      seedUsage(days?: number): {
        projectId: string;
        workflowId: string;
        runIds: string[];
        providerIds: string[];
      };
      /**
       * Round 5's named stories: `ingest-progress`, `ingest-failed`, `memory-updated`,
       * `trace-full`. Answers the ids it created.
       */
      playRound5Scenario(
        name: Round5Scenario,
        options?: { projectId?: string; nodeId?: string },
      ): Round5ScenarioResult;
      /** Connect two seeded nodes by port name through the same rules the handlers use. */
      connect(
        workflowId: string,
        fromNodeId: string,
        fromPort: string,
        toNodeId: string,
        toPort: string,
      ): void;
    };
  }
}

/**
 * Mock mode (VITE_ACE_MOCK=1): MSW intercepts `/api/v1` in the browser and a FakeWebSocket
 * plays the engine's side of `/ws`. State lives in localStorage so a second tab is a second
 * client of the same engine.
 */
/**
 * Which scenario the next run plays, kept in localStorage beside the mock database. A Playwright
 * test picks the scenario and then navigates, and a navigation reloads the module — without this
 * the choice would silently revert to the happy path on the way to the Canvas.
 */
const SCENARIO_KEY = 'ace.mock.scenario';
/** The pace, kept the same way and for the same reason (D200). */
const PACE_KEY = 'ace.mock.pace';
/** The ingest pace, kept the same way (round 5). */
const INGEST_PACE_KEY = 'ace.mock.ingestPace';

type ScenarioName = Parameters<typeof setScenario>[0];
type StreamPace = Parameters<typeof setStreamPace>[0];

function restoreScenario(): void {
  try {
    const stored = localStorage.getItem(SCENARIO_KEY);
    if (stored) setScenario(stored as ScenarioName);
    const storedPace = localStorage.getItem(PACE_KEY);
    if (storedPace) setStreamPace(storedPace as StreamPace);
    const storedIngestPace = localStorage.getItem(INGEST_PACE_KEY);
    if (storedIngestPace) setIngestPace(Number(storedIngestPace));
  } catch {
    // private mode or blocked storage: the default scenario is fine
  }
}

export async function startMocks(): Promise<{ WebSocket: typeof WebSocket }> {
  const db = new MockDb({ persist: true });
  restoreScenario();
  const worker = setupWorker(
    ...createRound5Handlers(db),
    ...createRound4Handlers(db),
    ...createRound3Handlers(db),
    ...createRound2Handlers(db),
    ...createHandlers(db),
  );
  await worker.start({ onUnhandledRequest: 'bypass', quiet: true });

  window.__aceMock = {
    db,
    bumpVersion(workflowId) {
      db.load();
      const committed = db.commitGraph(workflowId, db.nodesOf(workflowId), db.edgesOf(workflowId), {
        silent: true,
      });
      return committed.version;
    },
    reset() {
      db.reset();
      try {
        localStorage.removeItem(SCENARIO_KEY);
        localStorage.removeItem(PACE_KEY);
        localStorage.removeItem(INGEST_PACE_KEY);
      } catch {
        // ignored, as above
      }
      setScenario('linear-complete');
      setStreamPace('normal');
      setChatScenario('chat-stream');
      setIngestPace(150);
      failNextIngest(false);
    },
    setLatency(ms) {
      db.setLatency(ms);
    },
    setScenario(name) {
      setScenario(name);
      try {
        localStorage.setItem(SCENARIO_KEY, name);
      } catch {
        // nothing to do: the scenario still applies to this page
      }
    },
    setChatScenario(name) {
      setChatScenario(name);
    },
    requireChatBlock(on) {
      requireChatBlock(on);
    },
    setStreamPace(pace) {
      setStreamPace(pace);
      try {
        localStorage.setItem(PACE_KEY, pace);
      } catch {
        // nothing to do: the pace still applies to this page
      }
    },
    dropSocket() {
      dropMockSockets();
    },
    setProviderStatus(id, status, message) {
      db.load();
      db.setProviderStatus(id, status as Parameters<typeof db.setProviderStatus>[1], message);
    },
    seedGraph(kinds, options = {}) {
      db.load();
      const project = db.createProject({ name: options.projectName ?? 'E2E' });
      const workflow = db.createWorkflow(project.id, options.workflowName ?? 'Flow');
      const provider =
        options.withModel === true
          ? (db.listProviders().find((each) => each.type === 'mock') ??
            db.createProvider({ type: 'mock', name: 'Mock' }))
          : undefined;
      const nodes = kinds.map((kind, i) => {
        const node = createNode(kind, workflow.id, { x: 80 + i * 300, y: 120 + (i % 2) * 40 });
        if (provider === undefined || (node.kind !== 'agent' && node.kind !== 'model')) return node;
        return {
          ...node,
          config: { ...node.config, providerId: provider.id, modelId: 'mock-chat' },
        } as typeof node;
      });
      db.commitGraph(workflow.id, nodes, [], { silent: true });
      return { projectId: project.id, workflowId: workflow.id, nodeIds: nodes.map((n) => n.id) };
    },
    addNode(workflowId, kind, position) {
      db.load();
      const node = createNode(kind, workflowId, position);
      db.commitGraph(workflowId, [...db.nodesOf(workflowId), node], db.edgesOf(workflowId));
      return node.id;
    },
    patchNodeConfig(workflowId, nodeId, patch) {
      db.load();
      const nodes = db.nodesOf(workflowId).map((node) => {
        if (node.id !== nodeId) return node;
        const patched = { ...node, config: { ...node.config, ...patch } } as typeof node;
        return { ...patched, ...derivePorts(patched) } as typeof node;
      });
      db.commitGraph(workflowId, nodes, db.edgesOf(workflowId), { silent: true });
    },
    seedRunnable(options = {}) {
      db.load();
      const project = db.createProject({ name: 'E2E run' });
      const workflow = db.createWorkflow(project.id, 'Runnable');
      const provider = db.createProvider({ type: 'mock', name: 'Mock' });

      const input = createNode('input', workflow.id, { x: 80, y: 140 });
      input.config = {
        ...input.config,
        text: options.text ?? 'summarise the report',
      } as typeof input.config;
      const agent = createNode('agent', workflow.id, { x: 400, y: 140 });
      agent.config = {
        ...agent.config,
        providerId: provider.id,
        modelId: options.modelId ?? 'mock-text',
        ...(options.outputTypes ? { outputTypes: options.outputTypes } : {}),
      } as unknown as typeof agent.config;
      const output = createNode('output', workflow.id, { x: 720, y: 140 });

      const edges = [
        {
          id: db.nextId(),
          workflowId: workflow.id,
          kind: 'data' as const,
          from: { nodeId: input.id, portId: input.outputs[0]!.id },
          to: { nodeId: agent.id, portId: agent.inputs[0]!.id },
        },
        {
          id: db.nextId(),
          workflowId: workflow.id,
          kind: 'data' as const,
          from: { nodeId: agent.id, portId: agent.outputs[0]!.id },
          to: { nodeId: output.id, portId: output.inputs[0]!.id },
        },
      ];
      db.commitGraph(workflow.id, [input, agent, output], edges, { silent: true });
      return {
        projectId: project.id,
        workflowId: workflow.id,
        providerId: provider.id,
        inputId: input.id,
        agentId: agent.id,
        outputId: output.id,
        edgeIds: edges.map((edge) => edge.id),
      };
    },
    requireApproval(nodeRunId, options = {}) {
      db.load();
      return requireApproval(db, nodeRunId, options)?.id;
    },
    approve(nodeRunId, note) {
      db.load();
      return decideApproval(db, nodeRunId, 'approve', note).ok;
    },
    reject(nodeRunId, note) {
      db.load();
      return decideApproval(db, nodeRunId, 'reject', note).ok;
    },
    pendingApprovals(runId) {
      db.load();
      return db.pendingApprovals(runId).map((request) => ({
        id: request.id,
        nodeRunId: request.nodeRunId,
        nodeName: request.nodeName,
      }));
    },
    setIngestPace(ms) {
      setIngestPace(ms);
      try {
        localStorage.setItem(INGEST_PACE_KEY, String(ms));
      } catch {
        // nothing to do: the pace still applies to this page
      }
    },
    failNextIngest(on) {
      failNextIngest(on);
    },
    seedKnowledgeBase(projectId, docs, options) {
      db.load();
      return seedKnowledgeBase(db, projectId, docs, options);
    },
    seedMemory(nodeId, entries) {
      db.load();
      seedMemory(db, nodeId, entries);
    },
    seedUsage(days) {
      db.load();
      return seedUsage(db, days);
    },
    playRound5Scenario(name, options) {
      db.load();
      return playRound5Scenario(db, name, options);
    },
    connect(workflowId, fromNodeId, fromPort, toNodeId, toPort) {
      db.load();
      const result = applyOpsWithRules(workflowId, db.nodesOf(workflowId), db.edgesOf(workflowId), [
        {
          op: 'add_edge',
          edge: {
            id: db.nextId(),
            workflowId,
            kind: 'data',
            from: { nodeId: fromNodeId, portId: `${fromNodeId}:out:${fromPort}` },
            to: { nodeId: toNodeId, portId: `${toNodeId}:in:${toPort}` },
          },
        },
      ]);
      if (!result.ok) throw new Error(result.message);
      db.commitGraph(workflowId, result.nodes, result.edges, { silent: true });
    },
  };

  return { WebSocket: createFakeWebSocket(db) as unknown as typeof WebSocket };
}

/** `?fixture=200`: seed the 200-node graph and answer where it lives (NFR-PERF-01). */
export function seedFixtureFromUrl(): { projectId: string; workflowId: string } | undefined {
  const url = new URL(window.location.href);
  if (url.searchParams.get('fixture') !== '200') return undefined;
  const db = window.__aceMock?.db;
  if (!db) return undefined;
  return seedPerfFixture(db);
}
