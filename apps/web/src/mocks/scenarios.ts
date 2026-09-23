import type { Edge, Node, NodeRun, NodeState, Part, Run, Usage } from '@ace/contracts';

import { newId } from '../lib/ulid';
import { MOCK_PRICING } from './catalog';
import type { MockEvent } from './db';
import { assemblePrompt, buildEnvelope, promptVersion } from './prompt';

/**
 * Scripted run scenarios (round 2 §5 item 11). Each one turns a workflow graph into the exact
 * `§2.4` frames the engine would emit, with the delays that make streaming observable, so the live
 * run UI can be built and tested before A2 lands. The engine's mock provider (§2.6) produces the
 * same shapes, so a scenario means the same thing on both sides.
 */
export type ScenarioName =
  | 'linear-complete'
  | 'fallback-used'
  | 'contract-violation'
  /** Not a frame script: it makes pre-flight fail, so the run is BLOCKED and nothing is emitted. */
  | 'preflight-blocked'
  | 'slow-stream'
  | 'all-nine-states'
  | 'socket-drop';

export interface ScriptedFrame {
  /** Milliseconds after the previous frame. */
  after: number;
  event: Omit<MockEvent, 'seq'> & { transient?: boolean };
  /**
   * The `NodeRun` record as it stands once this frame has played. The engine persists node runs as
   * it goes and the inspector reads them back from `GET /runs/:id/node-runs` (FR-EXE-010), so the
   * mock writes them at the same moments the frames announce.
   */
  nodeRun?: NodeRun;
  /** `socket-drop` uses this to cut the connection part-way through. */
  dropSocket?: boolean;
}

const usage = (tokensIn: number, tokensOut: number): Usage => ({
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

const EXECUTABLE: ReadonlySet<Node['kind']> = new Set(['agent', 'model', 'transform']);

/** The nodes a run actually executes, left to right, following the data edges. */
function executionOrder(nodes: Node[], edges: Edge[]): Node[] {
  const executable = nodes.filter((node) => EXECUTABLE.has(node.kind));
  const position = new Map(nodes.map((node) => [node.id, node.position.x]));
  const downstream = new Map<string, number>();
  for (const edge of edges) {
    downstream.set(edge.to.nodeId, (downstream.get(edge.to.nodeId) ?? 0) + 1);
  }
  return executable.sort(
    (a, b) =>
      (downstream.get(a.id) ?? 0) - (downstream.get(b.id) ?? 0) ||
      (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0),
  );
}

const WORDS =
  'the quick brown fox jumps over the lazy dog and keeps running until the field ends'.split(' ');

/** §2.6: the mock streams deterministic words derived from the input, so output never surprises. */
function streamText(node: Node, count: number): string[] {
  const seed = node.id.charCodeAt(node.id.length - 1) % WORDS.length;
  return Array.from({ length: count }, (_, i) => `${WORDS[(seed + i) % WORDS.length]} `);
}

interface Context {
  run: Run;
  workflowId: string;
  nodes: Node[];
  edges: Edge[];
}

const stateFrame = (
  ctx: Context,
  nodeRunId: string,
  nodeId: string,
  status: NodeState,
  after = 40,
  failureReason?: string,
): ScriptedFrame => ({
  after,
  event: {
    type: 'node.state',
    scope: 'workflow',
    workflowId: ctx.workflowId,
    payload: {
      runId: ctx.run.id,
      nodeRunId,
      nodeId,
      iteration: 1,
      attempt: 1,
      status,
      ...(failureReason === undefined ? {} : { failureReason }),
    },
  },
});

const tokenFrame = (
  ctx: Context,
  nodeRunId: string,
  delta: string,
  after: number,
): ScriptedFrame => ({
  after,
  event: {
    type: 'node.token',
    scope: 'workflow',
    workflowId: ctx.workflowId,
    transient: true,
    payload: { runId: ctx.run.id, nodeRunId, delta },
  },
});

/**
 * The `NodeRun` the engine would have written for this node (§2.3, FR-EXE-010): the envelopes that
 * fed it, the prompt that was assembled from them (§2.8), and whatever the run has produced so far.
 */
function nodeRunRecord(
  ctx: Context,
  node: Node,
  nodeRunId: string,
  reads: Part[],
  patch: Partial<NodeRun>,
): NodeRun {
  const config = node.config as {
    instructions?: string;
    systemPrompt?: string;
    outputTypes?: string[];
    outputContract?: { jsonSchema?: Record<string, unknown> };
    contextPolicy?: { budgetTokens: number };
  };
  const instructions = config.instructions ?? config.systemPrompt ?? '';
  const contract = {
    outputTypes: config.outputTypes?.length ? config.outputTypes : ['text'],
    ...(config.outputContract?.jsonSchema === undefined
      ? {}
      : { jsonSchema: config.outputContract.jsonSchema }),
  };
  const upstream = ctx.edges.find((edge) => edge.to.nodeId === node.id);
  const envelope = buildEnvelope({
    id: newId(),
    runId: ctx.run.id,
    fromNodeId: upstream?.from.nodeId ?? node.id,
    toNodeId: node.id,
    reads,
    budgetTokens: config.contextPolicy?.budgetTokens ?? 4000,
    outputTypes: contract.outputTypes,
    ...(contract.jsonSchema === undefined ? {} : { jsonSchema: contract.jsonSchema }),
    createdAt: ctx.run.startedAt,
  });
  return {
    id: nodeRunId,
    runId: ctx.run.id,
    nodeId: node.id,
    iteration: 1,
    attempt: 1,
    status: 'RUNNING',
    inputEnvelopes: [envelope],
    prompt: {
      version: promptVersion(instructions, contract),
      text: assemblePrompt({ instructions, reads, contract }),
    },
    usage: usage(0, 0),
    verdicts: [],
    toolCalls: [],
    startedAt: ctx.run.startedAt,
    ...patch,
  };
}

/** One executed node: READY → RUNNING → streamed tokens → output → COMPLETED, then its edges. */
function runNode(
  ctx: Context,
  node: Node,
  options: {
    tokenDelay: number;
    words: number;
    viaFallback?: boolean;
    modelId?: string;
    reads?: Part[];
  },
): { frames: ScriptedFrame[]; nodeRunId: string; text: string; usage: Usage } {
  const nodeRunId = newId();
  const deltas = streamText(node, options.words);
  const text = deltas.join('').trim();
  const spent = usage(12, deltas.length * 2);
  const reads = options.reads ?? [];
  const modelUsed = {
    providerId: (node.config as { providerId?: string }).providerId ?? newId(),
    modelId: options.modelId ?? (node.config as { modelId?: string }).modelId ?? 'mock-text',
    viaFallback: options.viaFallback ?? false,
  };
  const record = (patch: Partial<NodeRun>): NodeRun =>
    nodeRunRecord(ctx, node, nodeRunId, reads, patch);

  const frames: ScriptedFrame[] = [
    stateFrame(ctx, nodeRunId, node.id, 'READY', 20),
    { ...stateFrame(ctx, nodeRunId, node.id, 'RUNNING', 30), nodeRun: record({}) },
    ...deltas.map((delta) => tokenFrame(ctx, nodeRunId, delta, options.tokenDelay)),
    {
      after: 30,
      nodeRun: record({ output: [{ type: 'text', text }], usage: spent, modelUsed }),
      event: {
        type: 'node.output',
        scope: 'workflow',
        workflowId: ctx.workflowId,
        payload: {
          runId: ctx.run.id,
          nodeRunId,
          nodeId: node.id,
          output: [{ type: 'text', text }],
          usage: spent,
          modelUsed,
        },
      },
    },
    {
      ...stateFrame(ctx, nodeRunId, node.id, 'COMPLETED', 20),
      nodeRun: record({
        status: 'COMPLETED',
        output: [{ type: 'text', text }],
        usage: spent,
        modelUsed,
        endedAt: new Date(Date.parse(ctx.run.startedAt) + 400).toISOString(),
        durationMs: 400,
      }),
    },
  ];

  for (const edge of ctx.edges.filter((e) => e.from.nodeId === node.id)) {
    frames.push({
      after: 20,
      event: {
        type: 'edge.transfer',
        scope: 'workflow',
        workflowId: ctx.workflowId,
        payload: {
          runId: ctx.run.id,
          edgeId: edge.id,
          fromNodeId: edge.from.nodeId,
          toNodeId: edge.to.nodeId,
          iteration: 1,
          summary: text.slice(0, 120),
        },
      },
    });
  }

  return { frames, nodeRunId, text, usage: spent };
}

const started = (ctx: Context): ScriptedFrame => ({
  after: 10,
  event: {
    type: 'run.started',
    scope: 'workflow',
    workflowId: ctx.workflowId,
    payload: {
      run: {
        id: ctx.run.id,
        workflowId: ctx.run.workflowId,
        status: 'RUNNING',
        startedAt: ctx.run.startedAt,
        totals: ctx.run.totals,
      },
    },
  },
});

const completed = (
  ctx: Context,
  status: 'COMPLETE' | 'HALTED',
  totals: Usage,
  finalOutput?: Record<string, unknown>,
): ScriptedFrame[] => [
  {
    after: 20,
    event: {
      type: 'usage.updated',
      scope: 'workflow',
      workflowId: ctx.workflowId,
      payload: { runId: ctx.run.id, totals },
    },
  },
  {
    after: 20,
    event: {
      type: 'run.completed',
      scope: 'workflow',
      workflowId: ctx.workflowId,
      payload: {
        runId: ctx.run.id,
        status,
        totals,
        ...(status === 'HALTED' ? { haltReason: 'failure' } : {}),
        ...(finalOutput === undefined ? {} : { finalOutput }),
      },
    },
  },
];

const sumUsage = (parts: Usage[]): Usage =>
  parts.reduce(
    (total, part) => ({
      tokensIn: total.tokensIn + part.tokensIn,
      tokensOut: total.tokensOut + part.tokensOut,
      costUsd: Number((total.costUsd + part.costUsd).toFixed(6)),
      priceTableVersion: MOCK_PRICING.priceTableVersion,
    }),
    { tokensIn: 0, tokensOut: 0, costUsd: 0, priceTableVersion: MOCK_PRICING.priceTableVersion },
  );

/** The nine node states of Arch §19.1, so TC-EXE-008 can see each one rendered distinctly. */
const NINE_STATES: NodeState[] = [
  'IDLE',
  'READY',
  'RUNNING',
  'WAITING',
  'PAUSED',
  'COMPLETED',
  'STOPPED',
  'BLOCKED',
  'FAILED',
];

export function buildScenario(name: ScenarioName, ctx: Context): ScriptedFrame[] {
  // a blocked run never starts, so there is no frame to play (§2.7: zero provider calls)
  if (name === 'preflight-blocked') return [];

  const order = executionOrder(ctx.nodes, ctx.edges);
  const outputNode = ctx.nodes.find((node) => node.kind === 'output');
  const frames: ScriptedFrame[] = [started(ctx)];

  if (name === 'all-nine-states') {
    const target = order[0] ?? ctx.nodes[0];
    if (target) {
      const nodeRunId = newId();
      for (const status of NINE_STATES) {
        frames.push({
          ...stateFrame(ctx, nodeRunId, target.id, status, 60),
          nodeRun: nodeRunRecord(ctx, target, nodeRunId, [], { status }),
        });
      }
    }
    frames.push(...completed(ctx, 'HALTED', sumUsage([])));
    return frames;
  }

  if (name === 'contract-violation') {
    const target = order[0];
    if (target) {
      const nodeRunId = newId();
      const error = {
        kind: 'agent' as const,
        code: 'contract_violation',
        message: 'The model returned JSON that does not match the output contract.',
        retryable: false,
      };
      frames.push(stateFrame(ctx, nodeRunId, target.id, 'READY', 20));
      frames.push({
        ...stateFrame(ctx, nodeRunId, target.id, 'RUNNING', 30),
        nodeRun: nodeRunRecord(ctx, target, nodeRunId, [], {}),
      });
      frames.push(tokenFrame(ctx, nodeRunId, '{ "oops": ', 30));
      frames.push({
        after: 30,
        nodeRun: nodeRunRecord(ctx, target, nodeRunId, [], {
          status: 'RUNNING',
          output: [{ type: 'text', text: '{ "oops": ' }],
          error,
          failureReason: 'CONTRACT_VIOLATION',
        }),
        event: {
          type: 'node.error',
          scope: 'workflow',
          workflowId: ctx.workflowId,
          payload: {
            runId: ctx.run.id,
            nodeRunId,
            nodeId: target.id,
            error,
            failureReason: 'CONTRACT_VIOLATION',
          },
        },
      });
      frames.push({
        ...stateFrame(ctx, nodeRunId, target.id, 'FAILED', 20, 'CONTRACT_VIOLATION'),
        nodeRun: nodeRunRecord(ctx, target, nodeRunId, [], {
          status: 'FAILED',
          output: [{ type: 'text', text: '{ "oops": ' }],
          error,
          failureReason: 'CONTRACT_VIOLATION',
          endedAt: new Date(Date.parse(ctx.run.startedAt) + 300).toISOString(),
          durationMs: 300,
        }),
      });
    }
    frames.push(...completed(ctx, 'HALTED', usage(12, 4)));
    return frames;
  }

  const tokenDelay = name === 'slow-stream' ? 60 : 8;
  const words = name === 'slow-stream' ? 12 : 5;
  const spent: Usage[] = [];
  let lastText = '';

  const inputText = ctx.nodes
    .filter((node) => node.kind === 'input')
    .map((node) => (node.config as { text?: string }).text)
    .find((text) => text !== undefined && text !== '');

  order.forEach((node, index) => {
    const reads: Part[] =
      index === 0
        ? inputText === undefined
          ? []
          : [{ type: 'text', text: inputText }]
        : [{ type: 'text', text: lastText }];
    const result = runNode(ctx, node, {
      tokenDelay,
      words,
      reads,
      viaFallback: name === 'fallback-used' && index === 0,
      ...(name === 'fallback-used' && index === 0 ? { modelId: 'mock-text-fallback' } : {}),
    });
    frames.push(...result.frames);
    spent.push(result.usage);
    lastText = result.text;
    if (name === 'socket-drop' && index === 0) {
      frames.push({
        after: 10,
        dropSocket: true,
        event: { type: 'hello', scope: 'engine', payload: { seq: 0 } },
      });
    }
  });

  frames.push(
    ...completed(
      ctx,
      'COMPLETE',
      sumUsage(spent),
      outputNode ? { [outputNode.id]: [{ type: 'text', text: lastText }] } : undefined,
    ),
  );
  return frames;
}

export type { Context as ScenarioContext };
