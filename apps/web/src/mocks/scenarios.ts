import {
  APPROVAL_PREVIEW_MAX,
  allowedRunActions,
  loopBody,
  type ApprovalRequest,
  type Artifact,
  type BudgetHalt,
  type Edge,
  type GuardrailPolicyRef,
  type HaltReason,
  type Message,
  type MessageType,
  type Node,
  type NodeError,
  type NodeRun,
  type NodeState,
  type Part,
  type Run,
  type ToolCall,
  type Usage,
  type Verdict,
} from '@ace/contracts';

import { newId } from '../lib/ulid';
import { MEDIA_FIXTURES } from './artifacts-fixtures';
import { MOCK_PRICING } from './catalog';
import type { MockDb, MockEvent } from './db';
import { assemblePrompt, buildEnvelope, promptVersion } from './prompt';
import {
  applyMemoryOps,
  round5Behaviour,
  type Round5Behaviour,
  type Round5RunDeps,
} from './round5-run';
import { sha256Hex } from './sha256';

/**
 * Scripted run scenarios (round 2 §5 item 11, round 3 §2.6). Each one turns a workflow graph into
 * the exact frames the engine would emit, with the delays that make streaming observable, so the
 * live run UI can be built and tested before the engine lands. The engine's mock provider (round 2
 * §2.6) produces the same shapes, so a scenario means the same thing on both sides.
 *
 * Round 3 adds the eight scenarios the control and safety UI is built against. Two of them stop
 * dead part-way through and wait for something that arrives over REST — a resume (`paused`) or a
 * decision (`waiting-approval`) — which is what `hold` below is for.
 */
export type ScenarioName =
  | 'linear-complete'
  | 'fallback-used'
  | 'contract-violation'
  /** Not a frame script: it makes pre-flight fail, so the run is BLOCKED and nothing is emitted. */
  | 'preflight-blocked'
  | 'slow-stream'
  | 'all-nine-states'
  | 'socket-drop'
  /* round 3 (§2.1, §2.3, §2.4, §2.6) */
  | 'paused'
  | 'stopped'
  | 'waiting-approval'
  | 'budget-halt'
  | 'loop-3-iterations'
  | 'merge-any'
  | 'retry-429'
  | 'blocked-downstream'
  /* round 4 (§2.4, §2.6): tools, multimodal, timeline */
  | 'tool-loop'
  | 'destructive-approval'
  | 'vision-flow'
  | 'media-outputs'
  | 'timeline-six-types'
  /* round 5 (§2.6): a run whose trace holds every kind of entry */
  | 'trace-full';

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
  /**
   * What this frame changes about the persisted `Run` — a pause writes `pausedAt` and the actions
   * PAUSED allows. `run.completed` needs none of this: the applier derives the ending from its
   * payload.
   */
  run?: Partial<Run>;
  /** Recorded as pending, so `GET /runs/:id/approvals` answers it (FR-GRD-013). */
  approval?: ApprovalRequest;
  /**
   * Stop here. The rest of the script plays when a control or a decision arrives: `POST
   * /runs/:id/resume` (FR-CTL-002) or `POST /node-runs/:id/approve` (FR-GRD-013).
   */
  hold?: boolean;
  /** `socket-drop` uses this to cut the connection part-way through. */
  dropSocket?: boolean;
  /**
   * A side effect to run as this frame plays, given the db. Round 4 uses it to store the artifacts a
   * media output references (§2.6 `mock-media`) and the timeline rows a `message.created` announces,
   * so `GET /artifacts/:id/content` and `GET /messages` answer after a reload. Frames without one
   * (every round 2/3 frame) behave exactly as before.
   */
  effect?: (db: MockDb) => void;
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

// round 5: a Retrieval node runs too — it searches, it calls no model (§2.4)
const EXECUTABLE: ReadonlySet<Node['kind']> = new Set(['agent', 'model', 'transform', 'retrieval']);

/** The nodes a run actually executes, left to right, following the data edges. */
function executionOrder(nodes: Node[], edges: Edge[]): Node[] {
  const executable = nodes.filter((node) => EXECUTABLE.has(node.kind));
  const position = new Map(nodes.map((node) => [node.id, node.position.x]));
  const downstream = new Map<string, number>();
  for (const edge of edges) {
    // only data edges say what feeds what: a loop edge leads back, and counting it would put a
    // loop's last node before its first (§2.4, BR-05)
    if (edge.kind !== 'data') continue;
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
function streamText(node: Node, count: number, seedOffset = 0): string[] {
  const seed = (node.id.charCodeAt(node.id.length - 1) + seedOffset) % WORDS.length;
  return Array.from({ length: count }, (_, i) => `${WORDS[(seed + i) % WORDS.length]} `);
}

/**
 * How fast a scripted node streams its tokens.
 *
 * `normal` is the pace every scenario was written at — fast, because most tests only need the frames
 * to arrive in the right order. `slow` is what `mock-slow` costs against the real engine, about 2 s a
 * node, and it exists for one reason: a run control can only be clicked while the run is still live,
 * and a browser test's own click latency on a loaded 2-vCPU runner is a large fraction of a second.
 *
 * That reason has now produced the same defect twice. `slow-stream` streamed 12 words at 60 ms, so a
 * two-node chain was over in 1.5 s and Pause landed after COMPLETE. The §1 loop walk then failed the
 * same way: `loop-3-iterations` plays six node runs at the `normal` pace and finishes in 1.49 s
 * measured, against a click that can take longer than that to land. The pace belongs to the run the
 * harness asks for, not to the name of the story — which is why it is a knob (D200).
 *
 * What a pace is made of matters as much as how long it lasts: see `PACE` below.
 */
export type StreamPace = 'normal' | 'slow';

interface Pace {
  tokenDelay: number;
  words: number;
}

const PACE: Record<StreamPace, Pace> = {
  normal: { tokenDelay: 8, words: 5 },
  /*
   * ~2 s a node, spent on eight far-apart tokens rather than thirty-three close ones. The duration is
   * what a control needs; the frame *count* is pure cost, and it is paid in React renders on the node
   * card. At 33 words the §1 loop walk's six node runs meant 198 streamed frames and took 23-50 s of
   * wall clock against a 60 s test timeout — for a script only 12.5 s long. Eight tokens at 250 ms is
   * the same 2 s with a quarter of the renders.
   */
  slow: { tokenDelay: 250, words: 8 },
};

interface Context {
  run: Run;
  workflowId: string;
  nodes: Node[];
  edges: Edge[];
  /** The pace this run streams at (D200); `normal` unless the harness asked for `slow`. */
  pace?: StreamPace;
  /** The project's per-run cost cap, which `budget-halt` is measured against (§2.3, D80). */
  maxCostPerRunUsd?: number;
  /**
   * The policy a node was checked against, at the version it had when the run started: the node's
   * own override, or the project default (FR-GRD-002). Resolved by the caller, which holds the db.
   */
  policyFor?: (node: Node) => GuardrailPolicyRef | undefined;
  /**
   * Round 4: an Input node's `artifactId` resolved to the `Part` the vision flow reads (§2.6
   * `mock-vision`). Resolved by the caller, which holds the db and so the artifact's mime/name/size.
   */
  artifactPartFor?: (artifactId: string) => Part | undefined;
  /**
   * Round 5: knowledge-base search and agent memory, resolved by the caller against the db (§2.2,
   * §2.4). Without it no node run retrieves or remembers, which is every round 1–4 test.
   */
  round5?: Round5RunDeps;
}

/** Which iteration and attempt a frame belongs to — both 1 unless a loop or a retry says otherwise. */
interface Round {
  iteration?: number;
  attempt?: number;
}

const stateFrame = (
  ctx: Context,
  nodeRunId: string,
  nodeId: string,
  status: NodeState,
  after = 40,
  failureReason?: string,
  round: Round = {},
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
      iteration: round.iteration ?? 1,
      attempt: round.attempt ?? 1,
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
  round: Round = {},
  /** Round 5: what the context builder retrieved and remembered for this node run (§2.2, §2.4). */
  context: Pick<Round5Behaviour, 'retrieved' | 'memory'> = {},
): NodeRun {
  const config = node.config as {
    instructions?: string;
    systemPrompt?: string;
    outputTypes?: string[];
    outputContract?: { jsonSchema?: Record<string, unknown> };
    contextPolicy?: { budgetTokens: number };
    memory?: { enabled: boolean };
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
    ...(round.iteration === undefined ? {} : { iteration: round.iteration }),
    ...(context.retrieved === undefined ? {} : { retrieved: context.retrieved }),
    ...(context.memory === undefined ? {} : { memory: context.memory }),
  });
  const promptContext =
    context.retrieved === undefined && context.memory === undefined
      ? {}
      : {
          context: {
            ...(context.retrieved === undefined ? {} : { retrieved: context.retrieved }),
            ...(context.memory === undefined ? {} : { memory: context.memory }),
          },
        };
  const memoryEnabled = node.kind === 'agent' && config.memory?.enabled === true;
  return {
    id: nodeRunId,
    runId: ctx.run.id,
    nodeId: node.id,
    iteration: round.iteration ?? 1,
    attempt: round.attempt ?? 1,
    status: 'RUNNING',
    inputEnvelopes: [envelope],
    prompt: {
      version: promptVersion(instructions, contract),
      text: assemblePrompt({
        instructions,
        reads,
        contract,
        ...promptContext,
        ...(memoryEnabled ? { memoryEnabled } : {}),
      }),
    },
    usage: usage(0, 0),
    verdicts: [],
    toolCalls: [],
    startedAt: ctx.run.startedAt,
    // Which policy, at which version, checked this node run (FR-GRD-002) — the inspector names it.
    ...(ctx.policyFor?.(node) === undefined ? {} : { guardrailPolicy: ctx.policyFor(node) }),
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
    /** Round 3: the node run this continues, when the script already announced it. */
    nodeRunId?: string;
    /** Round 3: it is already READY (a resume, or the attempt before it failed). */
    skipReady?: boolean;
    /** Round 3: `merge` in `any` mode records the later arrival but never feeds it (FR-PAR-002). */
    skipTransfers?: boolean;
    /** Round 3: which loop iteration and which attempt this run is (§2.1, §2.4). */
    round?: Round;
    /** Round 3: shifts the streamed words, so one iteration's output differs from the next. */
    seedOffset?: number;
    /** Round 3: fields every record of this node run keeps — its verdicts, for instance. */
    carry?: Partial<NodeRun>;
  },
): { frames: ScriptedFrame[]; nodeRunId: string; text: string; output: Part[]; usage: Usage } {
  const nodeRunId = options.nodeRunId ?? newId();
  const round = options.round ?? {};
  const reads = options.reads ?? [];
  // Round 5: retrieval, memory and the §2.10 models; undefined for every round 1–4 graph
  const r5 =
    ctx.round5 === undefined
      ? undefined
      : round5Behaviour(node, reads, textOf(inputReads(ctx)), ctx.round5);
  const deltas =
    r5 !== undefined && (r5.streamed.length > 0 || !r5.calledModel)
      ? r5.streamed
      : streamText(node, options.words, options.seedOffset ?? 0);
  const text = r5 !== undefined && r5.output.length > 0 ? r5.text : deltas.join('').trim();
  const output: Part[] =
    r5 !== undefined && r5.output.length > 0 ? r5.output : [{ type: 'text', text }];
  // a Retrieval node calls no model, so it spends nothing and names no model (D234)
  const calledModel = r5?.calledModel ?? true;
  const spent = calledModel ? usage(12, deltas.length * 2) : usage(0, 0);
  const modelUsed = {
    providerId: (node.config as { providerId?: string }).providerId ?? newId(),
    modelId: options.modelId ?? (node.config as { modelId?: string }).modelId ?? 'mock-text',
    viaFallback: options.viaFallback ?? false,
  };
  const used = calledModel ? { modelUsed } : {};

  // the context point's verdict when it stripped hidden instructions from retrieved text (§2.3)
  const contextVerdict =
    r5?.stripped === undefined
      ? undefined
      : verdictOf(
          nodeRunId,
          {
            point: 'context',
            checkType: 'prompt_injection',
            action: 'warn',
            passed: false,
            reason: 'Hidden instructions were removed from retrieved text before the prompt.',
            strippedTypes: r5.stripped,
          },
          at(ctx, 40),
        );
  const r5Carry: Partial<NodeRun> =
    r5 === undefined
      ? {}
      : {
          ...(r5.sources === undefined ? {} : { sources: r5.sources }),
          ...(r5.memoryOps === undefined ? {} : { memoryOps: r5.memoryOps }),
          ...(contextVerdict === undefined
            ? {}
            : { verdicts: [...(options.carry?.verdicts ?? []), contextVerdict] }),
        };
  const record = (patch: Partial<NodeRun>): NodeRun =>
    nodeRunRecord(ctx, node, nodeRunId, reads, { ...options.carry, ...r5Carry, ...patch }, round, {
      ...(r5?.retrieved === undefined ? {} : { retrieved: r5.retrieved }),
      ...(r5?.memory === undefined ? {} : { memory: r5.memory }),
    });
  const memoryOps = r5?.memoryOps;

  const frames: ScriptedFrame[] = [
    ...(options.skipReady === true
      ? []
      : [stateFrame(ctx, nodeRunId, node.id, 'READY', 20, undefined, round)]),
    {
      ...stateFrame(ctx, nodeRunId, node.id, 'RUNNING', 30, undefined, round),
      nodeRun: record({}),
      // the remembered facts just went into an envelope (FR-MEM-003)
      ...(r5?.memory === undefined ? {} : { effect: (db: MockDb) => db.touchMemory(node.id) }),
    },
    ...(contextVerdict === undefined ? [] : [verdictFrame(ctx, contextVerdict, 10)]),
    ...deltas.map((delta) => tokenFrame(ctx, nodeRunId, delta, options.tokenDelay)),
    {
      after: 30,
      nodeRun: record({ output, usage: spent, ...used }),
      event: {
        type: 'node.output',
        scope: 'workflow',
        workflowId: ctx.workflowId,
        payload: {
          runId: ctx.run.id,
          nodeRunId,
          nodeId: node.id,
          output,
          usage: spent,
          ...used,
        },
      },
    },
    {
      ...stateFrame(ctx, nodeRunId, node.id, 'COMPLETED', 20, undefined, round),
      nodeRun: record({
        status: 'COMPLETED',
        output,
        usage: spent,
        ...used,
        endedAt: new Date(Date.parse(ctx.run.startedAt) + 400).toISOString(),
        durationMs: 400,
      }),
      // `__memory` ops are applied once the node run has succeeded (§2.2, FR-MEM-002)
      ...(memoryOps === undefined
        ? {}
        : { effect: (db: MockDb) => applyMemoryOps(db, node.id, memoryOps) }),
    },
  ];

  if (options.skipTransfers !== true) {
    for (const edge of ctx.edges.filter((e) => e.from.nodeId === node.id && e.kind === 'data')) {
      frames.push(transferFrame(ctx, edge, text, round.iteration ?? 1));
    }
  }

  return { frames, nodeRunId, text, output, usage: spent };
}

/** One handoff along a data edge, summarised for the edge label (FR-EXE-015). */
const transferFrame = (
  ctx: Context,
  edge: Edge,
  text: string,
  iteration: number,
): ScriptedFrame => ({
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
      iteration,
      summary: text.slice(0, 120),
    },
  },
});

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
  options: {
    finalOutput?: Record<string, unknown>;
    /** Why it halted; `failure` unless a control or a cap ended it (§2.6, BR-03). */
    haltReason?: HaltReason;
    /** Which cap tripped, and by how much — set only on `budget_exceeded` (D80). */
    budgetHalt?: BudgetHalt;
  } = {},
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
        ...(status === 'HALTED' ? { haltReason: options.haltReason ?? 'failure' } : {}),
        ...(options.finalOutput === undefined ? {} : { finalOutput: options.finalOutput }),
        ...(options.budgetHalt === undefined ? {} : { budgetHalt: options.budgetHalt }),
      },
    },
  },
];

/* -------------------------------------------------------------------------- */
/* Round 3 frames (§2.6)                                                       */
/* -------------------------------------------------------------------------- */

/**
 * One guardrail verdict, stored on its node run and emitted (FR-GRD-015). A redaction names the
 * types it removed and nothing else — the contract's `Verdict` is strict, so there is no field a
 * value could travel in (FR-GRD-014, D75).
 */
function verdictOf(
  nodeRunId: string,
  fields: Omit<Verdict, 'id' | 'nodeRunId' | 'at'>,
  at: string,
): Verdict {
  return { id: newId(), nodeRunId, at, ...fields };
}

const verdictFrame = (ctx: Context, verdict: Verdict, after = 30): ScriptedFrame => ({
  after,
  event: {
    type: 'guardrail.verdict',
    scope: 'workflow',
    workflowId: ctx.workflowId,
    payload: { runId: ctx.run.id, nodeRunId: verdict.nodeRunId, verdict },
  },
});

/** A node's failure: the error frame, then FAILED with its reason (Arch §28, BR-03). */
function failFrames(
  ctx: Context,
  node: Node,
  nodeRunId: string,
  error: NodeError,
  failureReason: 'RUN_FAILED' | 'CONTRACT_VIOLATION' | 'GUARDRAIL_VIOLATION',
  record: (patch: Partial<NodeRun>) => NodeRun,
  round: Round = {},
): ScriptedFrame[] {
  return [
    {
      after: 30,
      nodeRun: record({ status: 'RUNNING', error, failureReason }),
      event: {
        type: 'node.error',
        scope: 'workflow',
        workflowId: ctx.workflowId,
        payload: { runId: ctx.run.id, nodeRunId, nodeId: node.id, error, failureReason },
      },
    },
    {
      ...stateFrame(ctx, nodeRunId, node.id, 'FAILED', 20, failureReason, round),
      nodeRun: record({
        status: 'FAILED',
        error,
        failureReason,
        endedAt: new Date(Date.parse(ctx.run.startedAt) + 300).toISOString(),
        durationMs: 300,
      }),
    },
  ];
}

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

export function buildScenario(name: ScenarioName, given: Context): ScriptedFrame[] {
  // a blocked run never starts, so there is no frame to play (§2.7: zero provider calls)
  if (name === 'preflight-blocked') return [];

  /*
   * The one place a pace is decided. `slow-stream` is the scenario whose name *is* its pace, so it
   * pins `slow` whatever the harness asked for; every other scenario takes the harness's choice.
   * Everything below reads it off the context through `stream`, so no script carries a pace of its
   * own (D200).
   */
  const ctx: Context = {
    ...given,
    pace: name === 'slow-stream' ? 'slow' : (given.pace ?? 'normal'),
  };

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

  const round3 = buildRound3Scenario(name, ctx, order, outputNode);
  if (round3 !== undefined) return [...frames, ...round3];

  const round4 = buildRound4Scenario(name, ctx, order, outputNode);
  if (round4 !== undefined) return [...frames, ...round4];

  const traced = name === 'trace-full' ? traceFullScript(ctx, order, outputNode) : undefined;
  if (traced !== undefined) return [...frames, ...traced];

  const { tokenDelay, words } = stream(ctx);
  const spent: Usage[] = [];
  let lastText = '';
  // what the previous node produced — its text for every round 1–4 node, `{ hits }` json after a
  // Retrieval node (round 5 §2.4)
  let lastOutput: Part[] = [];

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
        : lastOutput;
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
    lastOutput = result.output;
    if (name === 'socket-drop' && index === 0) {
      frames.push({
        after: 10,
        dropSocket: true,
        event: { type: 'hello', scope: 'engine', payload: { seq: 0 } },
      });
    }
  });

  frames.push(
    ...completed(ctx, 'COMPLETE', sumUsage(spent), {
      ...(outputNode === undefined
        ? {}
        : { finalOutput: { [outputNode.id]: [{ type: 'text', text: lastText }] } }),
    }),
  );
  return frames;
}

/* -------------------------------------------------------------------------- */
/* Round 3 scenarios (§2.6): the eight stories the control and safety UI reads  */
/* -------------------------------------------------------------------------- */

/** The pace this run streams at — the only place a script asks (D200). */
const stream = (ctx: Context): Pace => PACE[ctx.pace ?? 'normal'];

/** What the first executed node reads: the Input node's text, when there is one. */
function inputReads(ctx: Context): Part[] {
  const text = ctx.nodes
    .filter((node) => node.kind === 'input')
    .map((node) => (node.config as { text?: string }).text)
    .find((value) => value !== undefined && value !== '');
  return text === undefined ? [] : [{ type: 'text', text }];
}

const textOf = (reads: readonly Part[]): string => {
  const first = reads.find((part) => part.type === 'text');
  return first !== undefined && first.type === 'text' ? first.text : '';
};

const finalOutput = (outputNode: Node | undefined, text: string) =>
  outputNode === undefined ? {} : { finalOutput: { [outputNode.id]: [{ type: 'text', text }] } };

/** Run these nodes one after another, each reading the one before it. */
function runChain(
  ctx: Context,
  nodes: readonly Node[],
  reads: Part[],
  options: { round?: Round; seedOffset?: number } = {},
): { frames: ScriptedFrame[]; spent: Usage[]; lastText: string } {
  const frames: ScriptedFrame[] = [];
  const spent: Usage[] = [];
  let currentReads = reads;
  let lastText = textOf(reads);
  for (const node of nodes) {
    const result = runNode(ctx, node, {
      ...stream(ctx),
      reads: currentReads,
      ...(options.round === undefined ? {} : { round: options.round }),
      ...(options.seedOffset === undefined ? {} : { seedOffset: options.seedOffset }),
    });
    frames.push(...result.frames);
    spent.push(result.usage);
    lastText = result.text;
    currentReads = [{ type: 'text', text: lastText }];
  }
  return { frames, spent, lastText };
}

/** Every node a data path leads to from `start`, `start` itself excluded (FR-ERR-006). */
function downstreamOf(start: string, edges: readonly Edge[]): Set<string> {
  const reached = new Set<string>();
  const queue = [start];
  for (const current of queue) {
    for (const edge of edges) {
      if (edge.kind !== 'data' || edge.from.nodeId !== current || reached.has(edge.to.nodeId))
        continue;
      reached.add(edge.to.nodeId);
      queue.push(edge.to.nodeId);
    }
  }
  return reached;
}

const at = (ctx: Context, offsetMs: number): string =>
  new Date(Date.parse(ctx.run.startedAt) + offsetMs).toISOString();

/**
 * The round 3 scripts, or `undefined` when this is not one of them — or when the graph cannot tell
 * the story (no merge node for `merge-any`, no loop edge to iterate), in which case the linear path
 * below plays instead of a run that would claim something the graph does not contain.
 */
function buildRound3Scenario(
  name: ScenarioName,
  ctx: Context,
  order: Node[],
  outputNode: Node | undefined,
): ScriptedFrame[] | undefined {
  switch (name) {
    case 'paused':
      return pausedScript(ctx, order, outputNode);
    case 'stopped':
      return stoppedScript(ctx, order);
    case 'waiting-approval':
      return waitingApprovalScript(ctx, order, outputNode);
    case 'budget-halt':
      return budgetHaltScript(ctx, order);
    case 'loop-3-iterations':
      return loopScript(ctx, order, outputNode);
    case 'merge-any':
      return mergeAnyScript(ctx, order, outputNode);
    case 'retry-429':
      return retryScript(ctx, order, outputNode);
    case 'blocked-downstream':
      return blockedDownstreamScript(ctx, order);
    default:
      return undefined;
  }
}

/** No new dispatch; what was running finishes (FR-CTL-001, D4). The queue waits for a resume. */
const pausedFrame = (ctx: Context, pausedAt: string): ScriptedFrame => ({
  after: 30,
  hold: true,
  run: { status: 'PAUSED', pausedAt, allowedActions: allowedRunActions('PAUSED') },
  event: {
    type: 'run.paused',
    scope: 'workflow',
    workflowId: ctx.workflowId,
    payload: { runId: ctx.run.id },
  },
});

/**
 * TC-CTL-001/002: the first node finishes, the next one is READY and goes PAUSED, and the run is
 * PAUSED with only the controls PAUSED allows. Everything after the hold plays on
 * `POST /runs/:id/resume`.
 */
function pausedScript(
  ctx: Context,
  order: Node[],
  outputNode: Node | undefined,
): ScriptedFrame[] | undefined {
  const first = order[0];
  if (first === undefined) return undefined;

  const frames: ScriptedFrame[] = [];
  const spent: Usage[] = [];
  const opening = runNode(ctx, first, { ...stream(ctx), reads: inputReads(ctx) });
  frames.push(...opening.frames);
  spent.push(opening.usage);
  let lastText = opening.text;

  const next = order[1];
  if (next === undefined) {
    frames.push(pausedFrame(ctx, at(ctx, 500)));
    frames.push(...completed(ctx, 'COMPLETE', sumUsage(spent), finalOutput(outputNode, lastText)));
    return frames;
  }

  const nextRunId = newId();
  const reads: Part[] = [{ type: 'text', text: lastText }];
  const waiting = (status: NodeState): NodeRun =>
    nodeRunRecord(ctx, next, nextRunId, reads, { status });
  frames.push({ ...stateFrame(ctx, nextRunId, next.id, 'READY', 20), nodeRun: waiting('READY') });
  frames.push({ ...stateFrame(ctx, nextRunId, next.id, 'PAUSED', 30), nodeRun: waiting('PAUSED') });
  frames.push(pausedFrame(ctx, at(ctx, 500)));

  // resumed: the node the pause caught is READY again (the handler says so) and carries on
  const resumed = runNode(ctx, next, {
    ...stream(ctx),
    reads,
    nodeRunId: nextRunId,
    skipReady: true,
  });
  frames.push(...resumed.frames);
  spent.push(resumed.usage);
  lastText = resumed.text;

  const rest = runChain(ctx, order.slice(2), [{ type: 'text', text: lastText }]);
  frames.push(...rest.frames);
  spent.push(...rest.spent);
  if (order.length > 2) lastText = rest.lastText;

  frames.push(...completed(ctx, 'COMPLETE', sumUsage(spent), finalOutput(outputNode, lastText)));
  return frames;
}

/**
 * TC-ERR-008: the node that was running goes STOPPED — no failure reason, no error, so nothing can
 * mistake it for a failure (FR-ERR-007) — and the run halts `stopped` (FR-CTL-003).
 */
function stoppedScript(ctx: Context, order: Node[]): ScriptedFrame[] | undefined {
  const target = order[0];
  if (target === undefined) return undefined;

  const nodeRunId = newId();
  const reads = inputReads(ctx);
  const record = (patch: Partial<NodeRun>): NodeRun =>
    nodeRunRecord(ctx, target, nodeRunId, reads, patch);

  return [
    stateFrame(ctx, nodeRunId, target.id, 'READY', 20),
    { ...stateFrame(ctx, nodeRunId, target.id, 'RUNNING', 30), nodeRun: record({}) },
    tokenFrame(ctx, nodeRunId, 'the quick ', 30),
    tokenFrame(ctx, nodeRunId, 'brown ', 30),
    {
      ...stateFrame(ctx, nodeRunId, target.id, 'STOPPED', 40),
      nodeRun: record({ status: 'STOPPED', endedAt: at(ctx, 400), durationMs: 400 }),
    },
    ...completed(ctx, 'HALTED', usage(12, 4), { haltReason: 'stopped' }),
  ];
}

/**
 * TC-GRD-008/009: an `ask_user` check puts the node in WAITING with an approval card, and nothing
 * else happens until a decision arrives (FR-GRD-013). The redact verdict before it shows what
 * FR-GRD-014 means: the type was removed, and no field on a `Verdict` could carry the value.
 */
function waitingApprovalScript(
  ctx: Context,
  order: Node[],
  outputNode: Node | undefined,
): ScriptedFrame[] | undefined {
  const target = order[0];
  if (target === undefined) return undefined;

  const nodeRunId = newId();
  const reads = inputReads(ctx);
  const leak = verdictOf(
    nodeRunId,
    {
      point: 'output',
      checkType: 'secret_leak',
      action: 'redact',
      passed: false,
      reason: 'A key-shaped string was masked before the output moved on.',
      redactedTypes: ['api_key'],
    },
    at(ctx, 300),
  );
  const ask = verdictOf(
    nodeRunId,
    {
      point: 'output',
      checkType: 'pii',
      action: 'ask_user',
      passed: false,
      reason: 'The output contains an email address.',
    },
    at(ctx, 320),
  );
  const verdicts = [leak, ask];
  const record = (patch: Partial<NodeRun>): NodeRun =>
    nodeRunRecord(ctx, target, nodeRunId, reads, { verdicts, ...patch });

  const request: ApprovalRequest = {
    id: newId(),
    runId: ctx.run.id,
    nodeRunId,
    nodeId: target.id,
    nodeName: target.name,
    point: 'output',
    checkType: 'pii',
    reason: ask.reason,
    preview: `${target.name} wrote: contact [email redacted] for the full report.`.slice(
      0,
      APPROVAL_PREVIEW_MAX,
    ),
    requestedAt: at(ctx, 340),
  };

  const frames: ScriptedFrame[] = [
    stateFrame(ctx, nodeRunId, target.id, 'READY', 20),
    { ...stateFrame(ctx, nodeRunId, target.id, 'RUNNING', 30), nodeRun: record({}) },
    tokenFrame(ctx, nodeRunId, 'contact ', 30),
    tokenFrame(ctx, nodeRunId, 'the author ', 30),
    { ...verdictFrame(ctx, leak), nodeRun: record({ verdicts: [leak] }) },
    { ...verdictFrame(ctx, ask), nodeRun: record({}) },
    {
      ...stateFrame(ctx, nodeRunId, target.id, 'WAITING', 30),
      nodeRun: record({ status: 'WAITING' }),
    },
    {
      after: 20,
      hold: true,
      approval: request,
      event: {
        type: 'node.approval_required',
        scope: 'workflow',
        workflowId: ctx.workflowId,
        payload: { runId: ctx.run.id, request },
      },
    },
  ];

  // approved: the node picks up where it paused, with its verdicts still on the record
  const spent: Usage[] = [];
  const resumed = runNode(ctx, target, {
    ...stream(ctx),
    reads,
    nodeRunId,
    skipReady: true,
    carry: { verdicts },
  });
  frames.push(...resumed.frames);
  spent.push(resumed.usage);

  const rest = runChain(ctx, order.slice(1), [{ type: 'text', text: resumed.text }]);
  frames.push(...rest.frames);
  spent.push(...rest.spent);
  const lastText = order.length > 1 ? rest.lastText : resumed.text;

  frames.push(...completed(ctx, 'COMPLETE', sumUsage(spent), finalOutput(outputNode, lastText)));
  return frames;
}

/**
 * TC-GRD-012: the totals climb, the cost check blocks the next dispatch and the run halts
 * `budget_exceeded` saying which cap tripped and by how much (FR-GRD-008, D79, D80).
 */
function budgetHaltScript(ctx: Context, order: Node[]): ScriptedFrame[] | undefined {
  const first = order[0];
  if (first === undefined) return undefined;

  const capUsd = ctx.maxCostPerRunUsd ?? 0.01;
  const round6 = (value: number): number => Number(value.toFixed(6));
  const climbing = [0.35, 0.7, 0.95].map((fraction, index): Usage => ({
    tokensIn: 400 * (index + 1),
    tokensOut: 900 * (index + 1),
    costUsd: round6(capUsd * fraction),
    priceTableVersion: MOCK_PRICING.priceTableVersion,
  }));
  const spentSoFar = climbing[climbing.length - 1]!;
  // the halt comes *before* the next dispatch, so the run stopped below the cap (§2.3, D80)
  const projectedUsd = round6(capUsd * 1.2);

  const opening = runNode(ctx, first, { ...stream(ctx), reads: inputReads(ctx) });
  const frames: ScriptedFrame[] = [...opening.frames];
  for (const totals of climbing) {
    frames.push({
      after: 40,
      run: { totals },
      event: {
        type: 'usage.updated',
        scope: 'workflow',
        workflowId: ctx.workflowId,
        payload: { runId: ctx.run.id, totals },
      },
    });
  }

  const verdict = verdictOf(
    opening.nodeRunId,
    {
      point: 'cost',
      checkType: 'max_cost_per_run',
      action: 'block',
      passed: false,
      reason: `The next node would take this run to $${projectedUsd}, over the $${capUsd} cap.`,
    },
    at(ctx, 600),
  );
  frames.push(verdictFrame(ctx, verdict, 20));
  frames.push(
    ...completed(ctx, 'HALTED', spentSoFar, {
      haltReason: 'budget_exceeded',
      budgetHalt: { scope: 'run', capUsd, costUsd: projectedUsd, projected: true },
    }),
  );
  return frames;
}

/**
 * TC-PAR-006: three iterations of a loop body, each with its own node runs and its own output, and
 * a `loop.iteration` frame in between — the last one carrying why the loop stopped (§2.4,
 * FR-PAR-003..005).
 */
function loopScript(
  ctx: Context,
  order: Node[],
  outputNode: Node | undefined,
): ScriptedFrame[] | undefined {
  const loopEdge = ctx.edges.find((edge) => edge.kind === 'loop');
  if (loopEdge === undefined) return undefined;

  const body = loopBody(loopEdge, ctx.edges);
  const bodyNodes = order.filter((node) => body.has(node.id));
  if (bodyNodes.length === 0) return undefined;

  const iterations = 3;
  const frames: ScriptedFrame[] = [];
  const spent: Usage[] = [];
  let reads = inputReads(ctx);
  let lastRunId = '';
  let lastNode = bodyNodes[bodyNodes.length - 1]!;

  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    for (const node of bodyNodes) {
      const result = runNode(ctx, node, {
        ...stream(ctx),
        reads,
        round: { iteration },
        // a different slice of the word list per iteration, so no two outputs read alike
        seedOffset: iteration * 3,
      });
      frames.push(...result.frames);
      spent.push(result.usage);
      reads = [{ type: 'text', text: result.text }];
      lastRunId = result.nodeRunId;
      lastNode = node;
    }

    const stop = iteration === iterations;
    frames.push({
      after: 30,
      ...(stop
        ? {
            nodeRun: nodeRunRecord(
              ctx,
              lastNode,
              lastRunId,
              reads,
              {
                status: 'COMPLETED',
                output: [{ type: 'text', text: textOf(reads) }],
                loopStop: 'max_iterations',
              },
              { iteration },
            ),
          }
        : {}),
      event: {
        type: 'loop.iteration',
        scope: 'workflow',
        workflowId: ctx.workflowId,
        payload: {
          runId: ctx.run.id,
          edgeId: loopEdge.id,
          targetNodeId: loopEdge.to.nodeId,
          // without `stop` this is the iteration the target now starts; with it, the last one run
          iteration: stop ? iteration : iteration + 1,
          ...(stop ? { stop: 'max_iterations' } : {}),
        },
      },
    });
  }

  const after = order.filter((node) => !body.has(node.id));
  const rest = runChain(ctx, after, reads);
  frames.push(...rest.frames);
  spent.push(...rest.spent);

  frames.push(
    ...completed(ctx, 'COMPLETE', sumUsage(spent), finalOutput(outputNode, rest.lastText)),
  );
  return frames;
}

/**
 * TC-PAR-002 in `any` mode: the merge node completes on the first branch to arrive, and the later
 * branch is recorded as a finished node run that was never fed into the merge.
 */
function mergeAnyScript(
  ctx: Context,
  order: Node[],
  outputNode: Node | undefined,
): ScriptedFrame[] | undefined {
  const mergeNode = ctx.nodes.find((node) => node.kind === 'merge');
  if (mergeNode === undefined) return undefined;
  const intoMerge = ctx.edges.filter(
    (edge) => edge.kind === 'data' && edge.to.nodeId === mergeNode.id,
  );
  const branches = intoMerge
    .map((edge) => order.find((node) => node.id === edge.from.nodeId))
    .filter((node): node is Node => node !== undefined);
  const [firstBranch, laterBranch] = branches;
  if (firstBranch === undefined || laterBranch === undefined) return undefined;

  const frames: ScriptedFrame[] = [];
  const spent: Usage[] = [];
  const reads = inputReads(ctx);

  const first = runNode(ctx, firstBranch, { ...stream(ctx), reads });
  frames.push(...first.frames);
  spent.push(first.usage);

  // the merge output names the port each arrival came in on, by port id (D78)
  const firstPort = intoMerge.find((edge) => edge.from.nodeId === firstBranch.id)!.to.portId;
  const merged = {
    inputs: [
      { port: firstPort, nodeId: firstBranch.id, parts: [{ type: 'text', text: first.text }] },
    ],
  };
  const mergeRunId = newId();
  const mergeRecord = (patch: Partial<NodeRun>): NodeRun =>
    nodeRunRecord(ctx, mergeNode, mergeRunId, [{ type: 'text', text: first.text }], patch);
  const mergeUsage = usage(0, 0);

  frames.push(stateFrame(ctx, mergeRunId, mergeNode.id, 'READY', 20));
  frames.push({
    ...stateFrame(ctx, mergeRunId, mergeNode.id, 'RUNNING', 20),
    nodeRun: mergeRecord({}),
  });
  frames.push({
    after: 20,
    nodeRun: mergeRecord({ output: [{ type: 'json', value: merged }] }),
    event: {
      type: 'node.output',
      scope: 'workflow',
      workflowId: ctx.workflowId,
      payload: {
        runId: ctx.run.id,
        nodeRunId: mergeRunId,
        nodeId: mergeNode.id,
        output: [{ type: 'json', value: merged }],
        usage: mergeUsage,
      },
    },
  });
  frames.push({
    ...stateFrame(ctx, mergeRunId, mergeNode.id, 'COMPLETED', 20),
    nodeRun: mergeRecord({
      status: 'COMPLETED',
      output: [{ type: 'json', value: merged }],
      endedAt: at(ctx, 500),
      durationMs: 500,
    }),
  });
  for (const edge of ctx.edges.filter((e) => e.kind === 'data' && e.from.nodeId === mergeNode.id)) {
    frames.push(transferFrame(ctx, edge, JSON.stringify(merged), 1));
  }

  // the later branch still finishes and is still recorded — it just never reaches the merge
  const later = runNode(ctx, laterBranch, { ...stream(ctx), reads, skipTransfers: true });
  frames.push(...later.frames);
  spent.push(later.usage);

  const after = order.filter((node) => node.id !== firstBranch.id && node.id !== laterBranch.id);
  const rest = runChain(ctx, after, [{ type: 'json', value: merged }]);
  frames.push(...rest.frames);
  spent.push(...rest.spent);

  frames.push(
    ...completed(ctx, 'COMPLETE', sumUsage(spent), {
      ...(outputNode === undefined
        ? {}
        : { finalOutput: { [outputNode.id]: [{ type: 'json', value: merged }] } }),
    }),
  );
  return frames;
}

/**
 * TC-ERR-005: a 429 is a `provider` failure, so the engine retries it by itself with backoff —
 * attempts 1 and 2 fail, attempt 3 completes, and each attempt is its own node run (§2.1).
 */
function retryScript(
  ctx: Context,
  order: Node[],
  outputNode: Node | undefined,
): ScriptedFrame[] | undefined {
  const target = order[0];
  if (target === undefined) return undefined;

  const reads = inputReads(ctx);
  const error: NodeError = {
    kind: 'provider',
    code: 'rate_limited',
    message: 'The provider answered 429 Too Many Requests.',
    retryable: true,
    ...((target.config as { providerId?: string }).providerId === undefined
      ? {}
      : { providerId: (target.config as { providerId?: string }).providerId! }),
  };

  const frames: ScriptedFrame[] = [];
  for (const attempt of [1, 2]) {
    const nodeRunId = newId();
    const record = (patch: Partial<NodeRun>): NodeRun =>
      nodeRunRecord(ctx, target, nodeRunId, reads, patch, { attempt });
    frames.push(stateFrame(ctx, nodeRunId, target.id, 'READY', 20, undefined, { attempt }));
    frames.push({
      ...stateFrame(ctx, nodeRunId, target.id, 'RUNNING', 30, undefined, { attempt }),
      nodeRun: record({}),
    });
    frames.push(...failFrames(ctx, target, nodeRunId, error, 'RUN_FAILED', record, { attempt }));
  }

  const third = runNode(ctx, target, { ...stream(ctx), reads, round: { attempt: 3 } });
  frames.push(...third.frames);
  const spent: Usage[] = [third.usage];

  const rest = runChain(ctx, order.slice(1), [{ type: 'text', text: third.text }]);
  frames.push(...rest.frames);
  spent.push(...rest.spent);
  const lastText = order.length > 1 ? rest.lastText : third.text;

  frames.push(...completed(ctx, 'COMPLETE', sumUsage(spent), finalOutput(outputNode, lastText)));
  return frames;
}

/**
 * TC-ERR-007: one node fails and everything after it is BLOCKED — never FAILED — with the
 * `workflow` error kind and the name of the node that blocked it (FR-ERR-006, BR-03).
 */
function blockedDownstreamScript(ctx: Context, order: Node[]): ScriptedFrame[] | undefined {
  const target = order[0];
  if (target === undefined) return undefined;

  const reads = inputReads(ctx);
  const nodeRunId = newId();
  const record = (patch: Partial<NodeRun>): NodeRun =>
    nodeRunRecord(ctx, target, nodeRunId, reads, patch);
  const error: NodeError = {
    kind: 'auth',
    code: 'unauthorized',
    message: 'The provider rejected the key.',
    retryable: false,
    ...((target.config as { providerId?: string }).providerId === undefined
      ? {}
      : { providerId: (target.config as { providerId?: string }).providerId! }),
  };

  const frames: ScriptedFrame[] = [
    stateFrame(ctx, nodeRunId, target.id, 'READY', 20),
    { ...stateFrame(ctx, nodeRunId, target.id, 'RUNNING', 30), nodeRun: record({}) },
    ...failFrames(ctx, target, nodeRunId, error, 'RUN_FAILED', record),
  ];

  const blocked = downstreamOf(target.id, ctx.edges);
  const blockedError: NodeError = {
    kind: 'workflow',
    code: 'upstream_failed',
    message: `Blocked by "${target.name}".`,
    retryable: false,
  };
  for (const node of order.filter((candidate) => blocked.has(candidate.id))) {
    const blockedRunId = newId();
    frames.push({
      ...stateFrame(ctx, blockedRunId, node.id, 'BLOCKED', 30, 'BLOCKED'),
      nodeRun: nodeRunRecord(ctx, node, blockedRunId, [], {
        status: 'BLOCKED',
        failureReason: 'BLOCKED',
        error: blockedError,
      }),
    });
  }

  frames.push(...completed(ctx, 'HALTED', usage(12, 4), { haltReason: 'failure' }));
  return frames;
}

/* -------------------------------------------------------------------------- */
/* Round 4 scenarios (§2.4, §2.6): tools, multimodal outputs, the timeline      */
/* -------------------------------------------------------------------------- */

/** The `tool.call` frame, as `mock-tool`/`mock-destructive` would log one (FR-TOOL-009). */
const toolCallFrame = (ctx: Context, nodeRunId: string, toolCall: ToolCall): ScriptedFrame => ({
  after: 30,
  event: {
    type: 'tool.call',
    scope: 'workflow',
    workflowId: ctx.workflowId,
    payload: { runId: ctx.run.id, nodeRunId, toolCall },
  },
});

/** One logged call. Args are as delivered; the engine redacts key-shaped values (BR-07). */
function toolCallOf(
  nodeRunId: string,
  toolName: string,
  args: unknown,
  resultSummary: string,
  status: ToolCall['status'],
  at: string,
  verdicts: Verdict[] = [],
): ToolCall {
  return {
    id: newId(),
    nodeRunId,
    toolName,
    args,
    resultSummary,
    durationMs: 12,
    status,
    verdicts,
    at,
  };
}

/** A passing tool-point verdict — the tool was enabled for the agent (FR-TOOL-002, FR-GRD-005). */
const toolAllowed = (nodeRunId: string, toolName: string, at: string): Verdict =>
  verdictOf(
    nodeRunId,
    {
      point: 'tool',
      checkType: 'tool_allowed',
      action: 'pass',
      passed: true,
      reason: `${toolName} is enabled for this agent.`,
    },
    at,
  );

/** A `message.created` frame that also stores the row, so `GET /messages` answers after a reload. */
function messageFrame(ctx: Context, message: Message, after = 30): ScriptedFrame {
  return {
    after,
    effect: (db) => {
      db.addMessage(message);
    },
    event: {
      type: 'message.created',
      scope: 'workflow',
      workflowId: ctx.workflowId,
      payload: { workflowId: ctx.workflowId, message },
    },
  };
}

const messageOf = (
  ctx: Context,
  type: MessageType,
  content: Part[],
  extra: Partial<Message> = {},
): Message => ({
  id: newId(),
  workflowId: ctx.workflowId,
  runId: ctx.run.id,
  type,
  content,
  at: at(ctx, 100),
  ...extra,
});

const textPreview = (parts: readonly Part[]): string => {
  const text = parts.find((part) => part.type === 'text');
  return text !== undefined && text.type === 'text' ? text.text : JSON.stringify(parts[0] ?? {});
};

/**
 * One node with an output of our choosing — the round 4 counterpart of `runNode`, which only ever
 * streams text. It carries the tool calls the loop logged, the media parts `mock-media` produced,
 * or the vision agent's description, and it can store artifacts as the output frame plays.
 */
function runCustomNode(
  ctx: Context,
  node: Node,
  options: {
    reads: Part[];
    output: Part[];
    nodeRunId?: string;
    round?: Round;
    toolCalls?: ToolCall[];
    verdicts?: Verdict[];
    /** Frames between RUNNING and the output — the loop's `tool.call`s, the approval hold. */
    beforeOutput?: ScriptedFrame[];
    outputEffect?: (db: MockDb) => void;
  },
): { frames: ScriptedFrame[]; nodeRunId: string; output: Part[]; usage: Usage } {
  const nodeRunId = options.nodeRunId ?? newId();
  const round = options.round ?? {};
  const spent = usage(12, options.output.length * 3);
  const modelUsed = {
    providerId: (node.config as { providerId?: string }).providerId ?? newId(),
    modelId: (node.config as { modelId?: string }).modelId ?? 'mock-text',
    viaFallback: false,
  };
  const carry: Partial<NodeRun> = {
    ...(options.toolCalls === undefined ? {} : { toolCalls: options.toolCalls }),
    ...(options.verdicts === undefined ? {} : { verdicts: options.verdicts }),
  };
  const record = (patch: Partial<NodeRun>): NodeRun =>
    nodeRunRecord(ctx, node, nodeRunId, options.reads, { ...carry, ...patch }, round);

  const frames: ScriptedFrame[] = [
    stateFrame(ctx, nodeRunId, node.id, 'READY', 20, undefined, round),
    {
      ...stateFrame(ctx, nodeRunId, node.id, 'RUNNING', 30, undefined, round),
      nodeRun: record({}),
    },
    ...(options.beforeOutput ?? []),
    {
      after: 30,
      nodeRun: record({ output: options.output, usage: spent, modelUsed }),
      ...(options.outputEffect === undefined ? {} : { effect: options.outputEffect }),
      event: {
        type: 'node.output',
        scope: 'workflow',
        workflowId: ctx.workflowId,
        payload: {
          runId: ctx.run.id,
          nodeRunId,
          nodeId: node.id,
          output: options.output,
          usage: spent,
          modelUsed,
        },
      },
    },
    {
      ...stateFrame(ctx, nodeRunId, node.id, 'COMPLETED', 20, undefined, round),
      nodeRun: record({
        status: 'COMPLETED',
        output: options.output,
        usage: spent,
        modelUsed,
        endedAt: at(ctx, 400),
        durationMs: 400,
      }),
    },
  ];
  for (const edge of ctx.edges.filter((e) => e.from.nodeId === node.id && e.kind === 'data')) {
    frames.push(transferFrame(ctx, edge, textPreview(options.output), round.iteration ?? 1));
  }
  return { frames, nodeRunId, output: options.output, usage: spent };
}

function buildRound4Scenario(
  name: ScenarioName,
  ctx: Context,
  order: Node[],
  outputNode: Node | undefined,
): ScriptedFrame[] | undefined {
  switch (name) {
    case 'tool-loop':
      return toolLoopScript(ctx, order, outputNode);
    case 'destructive-approval':
      return destructiveApprovalScript(ctx, order, outputNode);
    case 'vision-flow':
      return visionFlowScript(ctx, order, outputNode);
    case 'media-outputs':
      return mediaOutputsScript(ctx, order, outputNode);
    case 'timeline-six-types':
      return timelineScript(ctx, order, outputNode);
    default:
      return undefined;
  }
}

/**
 * TC-TOOL-010 / TC-GRD-014: the agent calls `echo` up to its tool-call limit, each call logged, then
 * answers without tools. The inspector reads the calls off the node run and the `tool.call` frames.
 */
function toolLoopScript(
  ctx: Context,
  order: Node[],
  outputNode: Node | undefined,
): ScriptedFrame[] | undefined {
  const agent = order[0];
  if (agent === undefined) return undefined;

  const inputText = textOf(inputReads(ctx)) || 'echo this';
  const limit = Math.min(
    (agent.config as { tools?: { maxToolCalls?: number } }).tools?.maxToolCalls ?? 3,
    5,
  );
  const nodeRunId = newId();
  const calls: ToolCall[] = [];
  const toolFrames: ScriptedFrame[] = [];
  for (let i = 0; i < limit; i += 1) {
    const call = toolCallOf(
      nodeRunId,
      'echo',
      { text: inputText },
      `echo → ${inputText}`,
      'ok',
      at(ctx, 200 + i * 40),
      [toolAllowed(nodeRunId, 'echo', at(ctx, 190 + i * 40))],
    );
    calls.push(call);
    toolFrames.push(toolCallFrame(ctx, nodeRunId, call));
  }

  const agentFrames = runCustomNode(ctx, agent, {
    reads: inputReads(ctx),
    nodeRunId,
    output: [{ type: 'text', text: `echo said: ${inputText}` }],
    toolCalls: calls,
    verdicts: calls.map((call) => call.verdicts[0]!).filter(Boolean),
    beforeOutput: toolFrames,
  });

  const rest = runChain(ctx, order.slice(1), [{ type: 'text', text: `echo said: ${inputText}` }]);
  const lastText = order.length > 1 ? rest.lastText : `echo said: ${inputText}`;
  return [
    ...agentFrames.frames,
    ...rest.frames,
    ...completed(
      ctx,
      'COMPLETE',
      sumUsage([agentFrames.usage, ...rest.spent]),
      finalOutput(outputNode, lastText),
    ),
  ];
}

/**
 * TC-GRD-008 destructive variant: a `sandbox_delete` call trips the destructive-action check, the
 * node WAITs with an approval card naming the tool and its args, and nothing plays until a decision.
 * Approve continues (the delete happens, the node completes); reject fails it GUARDRAIL_VIOLATION —
 * both handled by `decideApproval` in handlers-round3, exactly as `waiting-approval` is.
 */
function destructiveApprovalScript(
  ctx: Context,
  order: Node[],
  outputNode: Node | undefined,
): ScriptedFrame[] | undefined {
  const agent = order[0];
  if (agent === undefined) return undefined;

  const nodeRunId = newId();
  const reads = inputReads(ctx);
  const args = { path: 'notes.txt' };
  const askVerdict = verdictOf(
    nodeRunId,
    {
      point: 'tool',
      checkType: 'destructive_action',
      action: 'ask_user',
      passed: false,
      reason: 'sandbox_delete is destructive and needs approval.',
    },
    at(ctx, 300),
  );
  const record = (patch: Partial<NodeRun>): NodeRun =>
    nodeRunRecord(ctx, agent, nodeRunId, reads, { verdicts: [askVerdict], ...patch });

  const request: ApprovalRequest = {
    id: newId(),
    runId: ctx.run.id,
    nodeRunId,
    nodeId: agent.id,
    nodeName: agent.name,
    point: 'tool',
    checkType: 'destructive_action',
    reason: askVerdict.reason,
    preview: `sandbox_delete ${JSON.stringify(args)}`.slice(0, APPROVAL_PREVIEW_MAX),
    requestedAt: at(ctx, 320),
  };

  const frames: ScriptedFrame[] = [
    stateFrame(ctx, nodeRunId, agent.id, 'READY', 20),
    { ...stateFrame(ctx, nodeRunId, agent.id, 'RUNNING', 30), nodeRun: record({}) },
    { ...verdictFrame(ctx, askVerdict), nodeRun: record({}) },
    {
      ...stateFrame(ctx, nodeRunId, agent.id, 'WAITING', 30),
      nodeRun: record({ status: 'WAITING' }),
    },
    {
      after: 20,
      hold: true,
      approval: request,
      event: {
        type: 'node.approval_required',
        scope: 'workflow',
        workflowId: ctx.workflowId,
        payload: { runId: ctx.run.id, request },
      },
    },
  ];

  // approved: the delete happens, is logged, and the node completes with its verdicts kept
  const okCall = toolCallOf(
    nodeRunId,
    'sandbox_delete',
    args,
    'deleted notes.txt',
    'ok',
    at(ctx, 500),
    [askVerdict],
  );
  const continuation = runCustomNode(ctx, agent, {
    reads,
    nodeRunId,
    output: [{ type: 'text', text: 'Deleted notes.txt as requested.' }],
    toolCalls: [okCall],
    verdicts: [askVerdict],
    beforeOutput: [toolCallFrame(ctx, nodeRunId, okCall)],
  });
  // `runCustomNode` re-announces READY/RUNNING; drop them — the node is already RUNNING post-approve
  frames.push(...continuation.frames.slice(2));

  const rest = runChain(ctx, order.slice(1), [
    { type: 'text', text: 'Deleted notes.txt as requested.' },
  ]);
  const lastText = order.length > 1 ? rest.lastText : 'Deleted notes.txt as requested.';
  frames.push(
    ...rest.frames,
    ...completed(
      ctx,
      'COMPLETE',
      sumUsage([continuation.usage, ...rest.spent]),
      finalOutput(outputNode, lastText),
    ),
  );
  return frames;
}

/**
 * TC-MM-009: the vision agent reads the Input node's text and image and describes it —
 * "Image <name> (<size> bytes, <mime>)", the shape §2.6 gives `mock-vision` — then the rest runs.
 */
function visionFlowScript(
  ctx: Context,
  order: Node[],
  outputNode: Node | undefined,
): ScriptedFrame[] | undefined {
  const agent = order[0];
  if (agent === undefined) return undefined;

  const artifactIds = ctx.nodes
    .filter((node) => node.kind === 'input')
    .flatMap((node) => (node.config as { artifactIds?: string[] }).artifactIds ?? [])[0];
  const imagePart = artifactIds === undefined ? undefined : ctx.artifactPartFor?.(artifactIds);
  const reads: Part[] = [...inputReads(ctx), ...(imagePart === undefined ? [] : [imagePart])];

  const description =
    imagePart !== undefined && imagePart.type === 'image'
      ? `Image ${imagePart.name} (${imagePart.size} bytes, ${imagePart.mime})`
      : 'Image (no attachment found)';

  const vision = runCustomNode(ctx, agent, {
    reads,
    output: [{ type: 'text', text: description }],
  });
  const rest = runChain(ctx, order.slice(1), [{ type: 'text', text: description }]);
  const lastText = order.length > 1 ? rest.lastText : description;
  return [
    ...vision.frames,
    ...rest.frames,
    ...completed(
      ctx,
      'COMPLETE',
      sumUsage([vision.usage, ...rest.spent]),
      finalOutput(outputNode, lastText),
    ),
  ];
}

/** A media Part plus the artifact + bytes that back it, for `mock-media` (§2.6). */
function mediaPartFixture(
  kind: 'image' | 'audio' | 'video' | 'file',
  createdAt: string,
): { part: Part; artifact: Artifact; bytes: Uint8Array } {
  const fixture = MEDIA_FIXTURES[kind];
  const artifact: Artifact = {
    id: newId(),
    hash: sha256Hex(fixture.bytes),
    mime: fixture.mime,
    name: fixture.name,
    size: fixture.bytes.length,
    createdAt,
  };
  const part: Part = {
    type: kind,
    artifactId: artifact.id,
    mime: fixture.mime,
    name: fixture.name,
    size: fixture.bytes.length,
  };
  return { part, artifact, bytes: fixture.bytes };
}

/**
 * TC-MM-006: `mock-media` emits one Part of each of the seven data types, the four binary ones
 * stored as artifacts so the renderers can load their bytes. Every typed renderer has something.
 */
function mediaOutputsScript(
  ctx: Context,
  order: Node[],
  outputNode: Node | undefined,
): ScriptedFrame[] | undefined {
  const agent = order[0];
  if (agent === undefined) return undefined;

  const media = (['image', 'audio', 'video', 'file'] as const).map((kind) =>
    mediaPartFixture(kind, at(ctx, 200)),
  );
  const output: Part[] = [
    { type: 'text', text: 'Here is one output of every type.' },
    { type: 'json', value: { ok: true, items: [1, 2, 3] } },
    { type: 'code', language: 'python', text: 'print("hello from mock-media")' },
    ...media.map((entry) => entry.part),
  ];

  const node = runCustomNode(ctx, agent, {
    reads: inputReads(ctx),
    output,
    outputEffect: (db) => {
      for (const entry of media) db.insertArtifact(entry.artifact, entry.bytes);
    },
  });

  const finalOut = outputNode === undefined ? {} : { finalOutput: { [outputNode.id]: output } };
  return [...node.frames, ...completed(ctx, 'COMPLETE', node.usage, finalOut)];
}

/**
 * TC-CHAT-001: a run that produces one message of every timeline style — an `event` at start, the
 * agent's `agent` output, the Output node's `output`, an `error`, a `system` notice and a `user`
 * turn — so the six visually distinct types (FR-CHAT-001) can all be seen and filtered.
 */
function timelineScript(
  ctx: Context,
  order: Node[],
  outputNode: Node | undefined,
): ScriptedFrame[] | undefined {
  const agent = order[0];
  if (agent === undefined) return undefined;

  const agentText = 'The agent considered the request and replied.';
  const frames: ScriptedFrame[] = [
    messageFrame(ctx, messageOf(ctx, 'user', [{ type: 'text', text: 'Please run the workflow.' }])),
    messageFrame(ctx, messageOf(ctx, 'event', [{ type: 'text', text: 'Run started.' }])),
  ];

  const node = runCustomNode(ctx, agent, {
    reads: inputReads(ctx),
    output: [{ type: 'text', text: agentText }],
  });
  frames.push(...node.frames);
  frames.push(
    messageFrame(
      ctx,
      messageOf(ctx, 'agent', [{ type: 'text', text: agentText }], { nodeId: agent.id }),
    ),
  );

  if (outputNode !== undefined) {
    frames.push(
      messageFrame(
        ctx,
        messageOf(ctx, 'output', [{ type: 'text', text: agentText }], { nodeId: outputNode.id }),
      ),
    );
  }
  frames.push(
    messageFrame(
      ctx,
      messageOf(
        ctx,
        'error',
        [{ type: 'text', text: 'A downstream node failed to reach its provider.' }],
        {
          nodeId: agent.id,
        },
      ),
    ),
  );
  frames.push(
    messageFrame(
      ctx,
      messageOf(ctx, 'system', [{ type: 'text', text: 'Provider status changed to CONNECTED.' }]),
    ),
  );

  frames.push(...completed(ctx, 'COMPLETE', node.usage, finalOutput(outputNode, agentText)));
  return frames;
}

/* -------------------------------------------------------------------------- */
/* Round 5 (§2.6): a run whose trace holds every kind of entry                  */
/* -------------------------------------------------------------------------- */

/**
 * TC-OBS-001: "run with tools and guardrails → trace shows all in order". The first agent calls a
 * tool, trips an `ask_user` verdict, waits, is approved and finishes; the rest of the chain runs;
 * and when the graph has a loop edge (the `review-fix` template has one) its body runs a second
 * iteration and the loop stops — so the trace holds a `node_run`, `tool_call`, `verdict`,
 * `approval`, `loop` and `run_event` entry, each from its own event. Nothing holds: the approval is
 * decided in the script, so the run reaches COMPLETE on its own.
 */
function traceFullScript(
  ctx: Context,
  order: Node[],
  outputNode: Node | undefined,
): ScriptedFrame[] | undefined {
  const first = order.find((node) => node.kind === 'agent' || node.kind === 'model');
  if (first === undefined) return undefined;

  const reads = inputReads(ctx);
  const said = textOf(reads) || 'trace this';
  const nodeRunId = newId();
  const call = toolCallOf(
    nodeRunId,
    'echo',
    { text: said },
    `echo → ${said}`.slice(0, 200),
    'ok',
    at(ctx, 120),
    [toolAllowed(nodeRunId, 'echo', at(ctx, 110))],
  );
  const ask = verdictOf(
    nodeRunId,
    {
      point: 'output',
      checkType: 'pii',
      action: 'ask_user',
      passed: false,
      reason: 'The output contains an email address.',
    },
    at(ctx, 160),
  );
  const request: ApprovalRequest = {
    id: newId(),
    runId: ctx.run.id,
    nodeRunId,
    nodeId: first.id,
    nodeName: first.name,
    point: 'output',
    checkType: 'pii',
    reason: ask.reason,
    preview: `${first.name} wrote: contact [email redacted] for details.`.slice(
      0,
      APPROVAL_PREVIEW_MAX,
    ),
    requestedAt: at(ctx, 180),
  };
  const decision = {
    requestId: request.id,
    decision: 'approve' as const,
    note: 'Fine to share.',
    decidedAt: at(ctx, 220),
  };

  const text = `echo said: ${said}`;
  const head = runCustomNode(ctx, first, {
    reads,
    nodeRunId,
    output: [{ type: 'text', text }],
    toolCalls: [call],
    verdicts: [...call.verdicts, ask],
    beforeOutput: [
      toolCallFrame(ctx, nodeRunId, call),
      verdictFrame(ctx, ask),
      stateFrame(ctx, nodeRunId, first.id, 'WAITING', 20),
      {
        after: 20,
        event: {
          type: 'node.approval_required',
          scope: 'workflow',
          workflowId: ctx.workflowId,
          payload: { runId: ctx.run.id, request },
        },
      },
      {
        after: 30,
        event: {
          type: 'node.approval_decided',
          scope: 'workflow',
          workflowId: ctx.workflowId,
          payload: { runId: ctx.run.id, nodeRunId, decision },
        },
      },
      stateFrame(ctx, nodeRunId, first.id, 'RUNNING', 20),
    ],
  });
  // the decision is on the node run's record from the moment it is made (FR-GRD-013)
  const headFrames = head.frames.map((frame) =>
    frame.nodeRun?.id === nodeRunId
      ? { ...frame, nodeRun: { ...frame.nodeRun, approvals: [decision] } }
      : frame,
  );

  const frames: ScriptedFrame[] = [...headFrames];
  const spent: Usage[] = [head.usage];
  const rest = runChain(ctx, order.slice(order.indexOf(first) + 1), [{ type: 'text', text }]);
  frames.push(...rest.frames);
  spent.push(...rest.spent);
  let lastText = order.length > 1 ? rest.lastText : text;

  const loopEdge = ctx.edges.find((edge) => edge.kind === 'loop');
  if (loopEdge !== undefined) {
    const body = loopBody(loopEdge, ctx.edges);
    const bodyNodes = order.filter((node) => body.has(node.id));
    const loopFrame = (iteration: number, stop?: 'exit_condition'): ScriptedFrame => ({
      after: 30,
      event: {
        type: 'loop.iteration',
        scope: 'workflow',
        workflowId: ctx.workflowId,
        payload: {
          runId: ctx.run.id,
          edgeId: loopEdge.id,
          targetNodeId: loopEdge.to.nodeId,
          iteration,
          ...(stop === undefined ? {} : { stop }),
        },
      },
    });
    frames.push(loopFrame(2));
    const again = runChain(ctx, bodyNodes, [{ type: 'text', text: lastText }], {
      round: { iteration: 2 },
      seedOffset: 6,
    });
    frames.push(...again.frames, loopFrame(2, 'exit_condition'));
    spent.push(...again.spent);
    lastText = again.lastText;
  }

  frames.push(...completed(ctx, 'COMPLETE', sumUsage(spent), finalOutput(outputNode, lastText)));
  return frames;
}

/* -------------------------------------------------------------------------- */
/* One attempt on its own: what a retry or a re-run plays (§2.1, §2.5, D81)     */
/* -------------------------------------------------------------------------- */

/**
 * The frames of a single node run — a manual retry (FR-ERR-003), a retry with everything after it
 * (FR-ERR-004) or a re-run of one node (FR-CTL-005). The node run has already been announced READY
 * by the handler, so this picks up at RUNNING, and the run ends again when it is done (D81).
 */
export function buildAttemptScript(
  ctx: Context,
  node: Node,
  options: {
    nodeRunId: string;
    attempt: number;
    iteration?: number;
    reads: Part[];
    /** Everything reachable after it, for `withDownstream`; empty for one node alone. */
    downstream: readonly Node[];
  },
): ScriptedFrame[] {
  const round: Round = {
    attempt: options.attempt,
    ...(options.iteration === undefined ? {} : { iteration: options.iteration }),
  };
  const attempt = runNode(ctx, node, {
    ...stream(ctx),
    reads: options.reads,
    nodeRunId: options.nodeRunId,
    skipReady: true,
    round,
    // a second attempt that streamed the same words as the first would prove nothing
    seedOffset: options.attempt * 2,
  });
  const rest = runChain(ctx, options.downstream, [{ type: 'text', text: attempt.text }]);
  const outputNode = ctx.nodes.find((candidate) => candidate.kind === 'output');
  const lastText = options.downstream.length === 0 ? attempt.text : rest.lastText;
  return [
    ...attempt.frames,
    ...rest.frames,
    ...completed(
      ctx,
      'COMPLETE',
      sumUsage([ctx.run.totals, attempt.usage, ...rest.spent]),
      finalOutput(outputNode, lastText),
    ),
  ];
}

