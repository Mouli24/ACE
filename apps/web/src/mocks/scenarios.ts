import type { Edge, Node, NodeState, Run, Usage } from '@ace/contracts';

import { newId } from '../lib/ulid';
import { MOCK_PRICING } from './catalog';
import type { MockEvent } from './db';

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
  | 'slow-stream'
  | 'all-nine-states'
  | 'socket-drop';

export interface ScriptedFrame {
  /** Milliseconds after the previous frame. */
  after: number;
  event: Omit<MockEvent, 'seq'> & { transient?: boolean };
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

/** One executed node: READY → RUNNING → streamed tokens → output → COMPLETED, then its edges. */
function runNode(
  ctx: Context,
  node: Node,
  options: { tokenDelay: number; words: number; viaFallback?: boolean; modelId?: string },
): { frames: ScriptedFrame[]; nodeRunId: string; text: string; usage: Usage } {
  const nodeRunId = newId();
  const deltas = streamText(node, options.words);
  const text = deltas.join('').trim();
  const spent = usage(12, deltas.length * 2);

  const frames: ScriptedFrame[] = [
    stateFrame(ctx, nodeRunId, node.id, 'READY', 20),
    stateFrame(ctx, nodeRunId, node.id, 'RUNNING', 30),
    ...deltas.map((delta) => tokenFrame(ctx, nodeRunId, delta, options.tokenDelay)),
    {
      after: 30,
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
          modelUsed: {
            providerId: (node.config as { providerId?: string }).providerId ?? newId(),
            modelId:
              options.modelId ?? (node.config as { modelId?: string }).modelId ?? 'mock-text',
            viaFallback: options.viaFallback ?? false,
          },
        },
      },
    },
    stateFrame(ctx, nodeRunId, node.id, 'COMPLETED', 20),
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
  const order = executionOrder(ctx.nodes, ctx.edges);
  const outputNode = ctx.nodes.find((node) => node.kind === 'output');
  const frames: ScriptedFrame[] = [started(ctx)];

  if (name === 'all-nine-states') {
    const target = order[0] ?? ctx.nodes[0];
    if (target) {
      const nodeRunId = newId();
      for (const status of NINE_STATES) {
        frames.push(stateFrame(ctx, nodeRunId, target.id, status, 60));
      }
    }
    frames.push(...completed(ctx, 'HALTED', sumUsage([])));
    return frames;
  }

  if (name === 'contract-violation') {
    const target = order[0];
    if (target) {
      const nodeRunId = newId();
      frames.push(stateFrame(ctx, nodeRunId, target.id, 'READY', 20));
      frames.push(stateFrame(ctx, nodeRunId, target.id, 'RUNNING', 30));
      frames.push(tokenFrame(ctx, nodeRunId, '{ "oops": ', 30));
      frames.push({
        after: 30,
        event: {
          type: 'node.error',
          scope: 'workflow',
          workflowId: ctx.workflowId,
          payload: {
            runId: ctx.run.id,
            nodeRunId,
            nodeId: target.id,
            error: {
              kind: 'agent',
              code: 'contract_violation',
              message: 'The model returned JSON that does not match the output contract.',
              retryable: false,
            },
            failureReason: 'CONTRACT_VIOLATION',
          },
        },
      });
      frames.push(stateFrame(ctx, nodeRunId, target.id, 'FAILED', 20, 'CONTRACT_VIOLATION'));
    }
    frames.push(...completed(ctx, 'HALTED', usage(12, 4)));
    return frames;
  }

  const tokenDelay = name === 'slow-stream' ? 60 : 8;
  const words = name === 'slow-stream' ? 12 : 5;
  const spent: Usage[] = [];
  let lastText = '';

  order.forEach((node, index) => {
    const result = runNode(ctx, node, {
      tokenDelay,
      words,
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
