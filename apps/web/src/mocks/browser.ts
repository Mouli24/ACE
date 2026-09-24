import { setupWorker } from 'msw/browser';

import { MockDb } from './db';
import { seedPerfFixture } from './fixture';
import { createFakeWebSocket, dropMockSockets } from './fake-socket';
import { createHandlers } from './handlers';
import { createRound2Handlers, setScenario } from './handlers-round2';
import { createNode, type Round1NodeKind } from '../nodes/factory';
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
      /** Which scripted run scenario the next run plays (§5 item 11). */
      setScenario(name: Parameters<typeof setScenario>[0]): void;
      /** Cut every open socket, as an engine restart would (TC-EXE-013). */
      dropSocket(): void;
      /** Announce a provider state change without a reload (FR-PRV-004, TC-PRV-005). */
      setProviderStatus(id: string, status: string, message?: string): void;
      /** Create a project + workflow with one node per kind, laid out left to right. */
      seedGraph(
        kinds: Round1NodeKind[],
        options?: { projectName?: string; workflowName?: string },
      ): { projectId: string; workflowId: string; nodeIds: string[] };
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

type ScenarioName = Parameters<typeof setScenario>[0];

function restoreScenario(): void {
  try {
    const stored = localStorage.getItem(SCENARIO_KEY);
    if (stored) setScenario(stored as ScenarioName);
  } catch {
    // private mode or blocked storage: the default scenario is fine
  }
}

export async function startMocks(): Promise<{ WebSocket: typeof WebSocket }> {
  const db = new MockDb({ persist: true });
  restoreScenario();
  const worker = setupWorker(...createRound2Handlers(db), ...createHandlers(db));
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
      } catch {
        // ignored, as above
      }
      setScenario('linear-complete');
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
      const nodes = kinds.map((kind, i) =>
        createNode(kind, workflow.id, { x: 80 + i * 300, y: 120 + (i % 2) * 40 }),
      );
      db.commitGraph(workflow.id, nodes, [], { silent: true });
      return { projectId: project.id, workflowId: workflow.id, nodeIds: nodes.map((n) => n.id) };
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
