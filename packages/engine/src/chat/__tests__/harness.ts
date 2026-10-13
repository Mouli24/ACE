import {
  NodeSchema,
  derivePorts,
  type DataType,
  type Id,
  type Node,
  type Project,
  type Run,
  type Workflow,
} from '@ace/contracts';

import { createEventBus, type EventBus } from '../../events/index.js';
import { newId } from '../../ids.js';
import { createLogger } from '../../logging/index.js';
import type { FakeRepository } from '../../__tests__/fake-repository.js';
import { InProcessPubSubStub } from '../../__tests__/pubsub-stub.js';
import {
  LOCAL_SCOPE,
  type EngineEvent,
  type ModelInfo,
  type ModelRouter,
  type ProviderAdapter,
  type ProviderStatus,
  type RouteResult,
  type Scope,
  type StreamChunk,
} from '../../ports/index.js';
import { createChatService, type ChatServiceDeps, type ResolvedChatNode } from '../service.js';

export const scope: Scope = LOCAL_SCOPE;
export const PROVIDER_ID = newId();
export const MODEL_ID = 'mock-chat';

/** The silent logger the other engine tests use. */
export const silentLogger = createLogger({ level: 'silent', destination: { write: () => undefined } });

export function makeBus(repository: FakeRepository, now: () => string): {
  bus: EventBus;
  events: EngineEvent[];
} {
  const pubsub = new InProcessPubSubStub<EngineEvent>();
  const bus = createEventBus({ repository, scope, pubsub, now });
  const events: EngineEvent[] = [];
  void bus.subscribe((event) => events.push(event));
  return { bus, events };
}

export interface AdapterBehaviour {
  /** The reply the adapter streams, given the assembled prompt. Split into a few chunks. */
  reply?: (prompt: string) => string;
  tokensIn?: number;
  tokensOut?: number;
}

/** A provider adapter whose `generate` streams a text reply in three chunks (round 4 §2.6 mock). */
export function makeAdapter(behaviour: AdapterBehaviour = {}): ProviderAdapter {
  const reply = behaviour.reply ?? ((prompt) => (prompt.includes('answer in French') ? 'Bonjour le monde.' : 'You said hello.'));
  return {
    type: 'openai_compatible',
    check: async (): Promise<ProviderStatus> => ({ status: 'CONNECTED' }),
    listModels: async (): Promise<ModelInfo[]> => [],
    async *generate(req): AsyncIterable<StreamChunk> {
      const text = reply(req.prompt);
      const third = Math.ceil(text.length / 3) || 1;
      for (let i = 0; i < text.length; i += third) {
        yield { type: 'text', delta: text.slice(i, i + third) };
      }
      yield { type: 'usage', tokensIn: behaviour.tokensIn ?? 5, tokensOut: behaviour.tokensOut ?? 7 };
      yield { type: 'finish', reason: 'stop' };
    },
  };
}

/** A router that resolves everything to one fixed model, or refuses when told to. */
export function makeRouter(options: { refuse?: RouteResult } = {}): ModelRouter {
  const ok: RouteResult = {
    ok: true,
    route: { providerId: PROVIDER_ID, modelId: MODEL_ID, viaFallback: false },
  };
  const result = options.refuse ?? ok;
  return { resolve: () => result, resolveForBench: () => result };
}

let counter = 0;

/** A deterministic clock so `at` fields are stable and ordered. */
export function makeClock(): () => string {
  return () => `2026-09-30T10:00:${String(counter++ % 60).padStart(2, '0')}.000Z`;
}

export function makeProject(): Project {
  const at = '2026-09-30T09:00:00.000Z';
  return { id: newId(), name: 'Chat project', folderPath: '/tmp/ace/chat', createdAt: at, updatedAt: at };
}

export function makeWorkflow(projectId: Id): Workflow {
  const at = '2026-09-30T09:00:00.000Z';
  return {
    id: newId(),
    projectId,
    name: 'Chat workflow',
    version: 1,
    formatVersion: 1,
    createdAt: at,
    updatedAt: at,
  };
}

export function makeAgentNode(
  workflowId: Id,
  overrides: {
    instructions?: string;
    guardrailPolicyId?: Id;
    budgetTokens?: number;
    name?: string;
  } = {},
): Node {
  const id = newId();
  const config = {
    providerId: PROVIDER_ID,
    modelId: MODEL_ID,
    instructions: overrides.instructions ?? 'Be helpful.',
    inputTypes: ['text'] as DataType[],
    outputTypes: ['text'] as DataType[],
    routing: { policy: 'fixed', fallbackModelIds: [] },
    execution: { maxTokens: 1000, temperature: 0.2, timeoutMs: 30_000, retries: 0 },
    contextPolicy: { budgetTokens: overrides.budgetTokens ?? 4000 },
    ...(overrides.guardrailPolicyId === undefined ? {} : { guardrailPolicyId: overrides.guardrailPolicyId }),
    tools: { enabled: [], maxToolCalls: 5, allowedDomains: [] },
    knowledgeBaseIds: [],
    memory: { enabled: false },
    skillIds: [],
  };
  return NodeSchema.parse({
    id,
    workflowId,
    kind: 'agent',
    name: overrides.name ?? 'Writer',
    position: { x: 0, y: 0 },
    config,
    ...derivePorts({ id, kind: 'agent', config } as Parameters<typeof derivePorts>[0]),
  });
}

export function makeSimpleNode(workflowId: Id, kind: 'input' | 'output'): Node {
  const id = newId();
  const config = kind === 'input' ? { artifactIds: [], outputTypes: ['text'] as DataType[] } : {};
  return NodeSchema.parse({
    id,
    workflowId,
    kind,
    name: kind === 'input' ? 'Brief' : 'Result',
    position: { x: 0, y: 0 },
    config,
    ...derivePorts({ id, kind, config } as Parameters<typeof derivePorts>[0]),
  });
}

export function makeRun(id: Id, workflowId: Id, projectId: Id, nodes: Node[]): Run {
  return {
    id,
    workflowId,
    projectId,
    status: 'RUNNING',
    snapshot: { version: 1, nodes, edges: [] },
    inputs: {},
    preflightIssues: [],
    totals: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
    startedAt: '2026-09-30T10:00:00.000Z',
  };
}

/** Builds a chat service over a FakeRepository, with a resolveNode that reads it. */
export function makeChatService(
  repository: FakeRepository,
  bus: EventBus,
  overrides: Partial<ChatServiceDeps> & { workflowId?: Id; workflowIds?: Id[] } = {},
): ReturnType<typeof createChatService> {
  const now = overrides.now ?? makeClock();
  const resolveNode =
    overrides.resolveNode ??
    (async (nodeId: Id): Promise<ResolvedChatNode | null> => {
      // Test doubles know their workflow; the real root supplies a node-by-id lookup (see report).
      const workflows = [overrides.workflowId, ...(overrides.workflowIds ?? [])];
      for (const wf of workflows.filter((w): w is Id => w !== undefined)) {
        const node = (await repository.nodes.listByWorkflow(scope, wf)).find((n) => n.id === nodeId);
        if (node === undefined) continue;
        const workflow = await repository.workflows.get(scope, node.workflowId);
        if (workflow === null) continue;
        return { node, projectId: workflow.projectId, workflowId: node.workflowId };
      }
      return null;
    });

  return createChatService({
    scope,
    repository,
    bus,
    logger: silentLogger,
    router: overrides.router ?? makeRouter(),
    adapterFor: overrides.adapterFor ?? (async () => makeAdapter()),
    modelsFor: overrides.modelsFor ?? (async () => []),
    runGated: overrides.runGated ?? (async (_id, fn) => fn()),
    resolveNode,
    tokenBatchMs: overrides.tokenBatchMs ?? 5,
    now,
    ...(overrides.nextId === undefined ? {} : { nextId: overrides.nextId }),
    ...(overrides.policies === undefined ? {} : { policies: overrides.policies }),
    ...(overrides.checks === undefined ? {} : { checks: overrides.checks }),
    ...(overrides.masker === undefined ? {} : { masker: overrides.masker }),
    ...(overrides.startRun === undefined ? {} : { startRun: overrides.startRun }),
    ...(overrides.tools === undefined ? {} : { tools: overrides.tools }),
    ...(overrides.checkpoints === undefined ? {} : { checkpoints: overrides.checkpoints }),
    ...(overrides.contextGuard === undefined ? {} : { contextGuard: overrides.contextGuard }),
  });
}
