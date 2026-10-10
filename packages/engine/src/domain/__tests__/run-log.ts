import {
  AgentConfigSchema,
  type EnvelopeKind,
  type HumanMessagePayload,
  type Id,
  type InstructionState,
  type Node,
  type NodeState,
  type Part,
  type ProviderType,
  type RunDomainConfig,
  type TurnTrigger,
  type Usage,
} from '@ace/contracts';

import type { EngineEvent } from '../../ports/index.js';
import { domainContextFor, type DomainContext } from '../context.js';

/**
 * A run's event log written by hand, one event at a time, for the projection's fixtures. Each
 * event gets the next `seq` and a clock a second later than the last, exactly as the bus would
 * stamp them.
 */

export const RUN = '01JBXQ8Z9KQ4R7N2VWXYZ0RN55';
export const WF = '01JBXQ8Z9KQ4R7N2VWXYZ0WKFW';
const START = Date.parse('2026-10-10T09:00:00.000Z');

/** Ids in creation order (ULIDs sort by time). */
export const nodeId = (n: number): Id => `01JBXQ8Z9KQ4R7N2VWXYZ0N${String(n).padStart(3, '0')}`;
export const runOf = (n: number): Id => `01JBXQ8Z9KQ4R7N2VWXYZ0R${String(n).padStart(3, '0')}`;
export const msgOf = (n: number): Id => `01JBXQ8Z9KQ4R7N2VWXYZ0M${String(n).padStart(3, '0')}`;
export const envOf = (n: number): Id => `01JBXQ8Z9KQ4R7N2VWXYZ0E${String(n).padStart(3, '0')}`;

export function agent(
  n: number,
  name: string,
  extra: { brain?: boolean; handle?: string } = {},
): Node {
  return {
    id: nodeId(n),
    workflowId: WF,
    kind: 'agent',
    name,
    position: { x: 0, y: 0 },
    inputs: [],
    outputs: [],
    ...(extra.handle === undefined ? {} : { handle: extra.handle }),
    config: AgentConfigSchema.parse({
      instructions: `Act as ${name}.`,
      inputTypes: ['text'],
      outputTypes: ['text'],
      ...(extra.brain === undefined ? {} : { brain: extra.brain }),
    }),
  };
}

export const text = (value: string): Part[] => [{ type: 'text', text: value }];

export class RunLog {
  readonly events: EngineEvent[] = [];
  private seq = 100;
  private clock = START;

  constructor(readonly nodes: Node[]) {}

  context(providerTypes?: ReadonlyMap<Id, ProviderType>): DomainContext {
    return domainContextFor(RUN, this.nodes, providerTypes);
  }

  push(type: string, payload: unknown): this {
    this.seq += 1;
    this.clock += 1_000;
    this.events.push({
      seq: this.seq,
      type,
      runId: RUN,
      workflowId: WF,
      payload,
      createdAt: new Date(this.clock).toISOString(),
    });
    return this;
  }

  started(): this {
    return this.push('run.started', {
      run: {
        id: RUN,
        workflowId: WF,
        status: 'RUNNING',
        startedAt: new Date(this.clock).toISOString(),
        totals: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
      },
    });
  }

  config(config: Partial<RunDomainConfig> = {}): this {
    return this.push('run.config', {
      runId: RUN,
      config: {
        routing: 'supervised',
        loopGuardLimit: 3,
        tokenBudget: null,
        stayOpen: false,
        ...config,
      },
    });
  }

  state(
    node: number,
    run: number,
    status: NodeState,
    extra: { attempt?: number; trigger?: TurnTrigger; durationMs?: number } = {},
  ): this {
    return this.push('node.state', {
      runId: RUN,
      nodeRunId: runOf(run),
      nodeId: nodeId(node),
      iteration: 1,
      attempt: extra.attempt ?? 1,
      status,
      ...(status === 'FAILED' ? { failureReason: 'CONTRACT_VIOLATION' } : {}),
      ...(extra.trigger === undefined ? {} : { trigger: extra.trigger }),
      ...(extra.durationMs === undefined ? {} : { durationMs: extra.durationMs }),
    });
  }

  output(
    node: number,
    run: number,
    parts: Part[],
    usage: Usage = { tokensIn: 10, tokensOut: 5, costUsd: 0 },
  ): this {
    return this.push('node.output', {
      runId: RUN,
      nodeRunId: runOf(run),
      nodeId: nodeId(node),
      output: parts,
      usage,
      modelUsed: {
        providerId: '01JBXQ8Z9KQ4R7N2VWXYZ0PRVD',
        modelId: 'sonnet',
        viaFallback: false,
      },
    });
  }

  error(node: number, run: number, message: string): this {
    return this.push('node.error', {
      runId: RUN,
      nodeRunId: runOf(run),
      nodeId: nodeId(node),
      error: { kind: 'agent', code: 'contract_violation', message, retryable: false },
      failureReason: 'CONTRACT_VIOLATION',
    });
  }

  turnUsage(
    node: number,
    run: number,
    usage: Usage,
    providerType: ProviderType = 'claude_code',
    modelId = 'sonnet',
  ): this {
    return this.push('usage.updated', {
      runId: RUN,
      totals: usage,
      turn: { nodeRunId: runOf(run), nodeId: nodeId(node), providerType, modelId, usage },
    });
  }

  /** A whole ordinary turn: RUNNING, output, usage, COMPLETED. */
  turn(node: number, run: number, reply: string, usage?: Usage, trigger?: TurnTrigger): this {
    this.state(node, run, 'RUNNING', trigger === undefined ? {} : { trigger });
    this.output(node, run, text(reply), usage);
    if (usage !== undefined) this.turnUsage(node, run, usage);
    return this.state(node, run, 'COMPLETED');
  }

  human(
    message: number,
    textValue: string,
    to: { node: number; handle: string }[],
    extra: Partial<HumanMessagePayload> = {},
  ): this {
    return this.push('human.message', {
      runId: RUN,
      messageId: msgOf(message),
      text: textValue,
      addressing: to.length === 0 ? 'goal' : 'direct',
      mentions: to.map((each) => ({ nodeId: nodeId(each.node), handle: each.handle, via: 'name' })),
      deliveryMode: 'queue',
      ...extra,
    });
  }

  instruction(message: number, node: number, state: InstructionState, run?: number): this {
    return this.push('instruction.state', {
      runId: RUN,
      messageId: msgOf(message),
      nodeId: nodeId(node),
      state,
      ...(run === undefined ? {} : { nodeRunId: runOf(run) }),
    });
  }

  envelope(
    env: number,
    run: number,
    from: number,
    to: number[],
    kind: EnvelopeKind,
    summary: string,
    extra: { textSource?: 'summary' | 'auto'; inReplyTo?: Id } = {},
  ): this {
    return this.push('envelope.sent', {
      runId: RUN,
      envelopeId: envOf(env),
      nodeRunId: runOf(run),
      kind,
      fromNodeId: nodeId(from),
      toNodeIds: to.map(nodeId),
      summary,
      textSource: extra.textSource ?? 'summary',
      ...(extra.inReplyTo === undefined ? {} : { inReplyTo: extra.inReplyTo }),
      artifacts: [],
    });
  }

  routed(
    env: number,
    decision: 'FORWARDED' | 'HELD' | 'REJECTED' | 'EDITED',
    by: 'brain' | 'human',
    extra: object = {},
  ): this {
    return this.push('envelope.routed', {
      runId: RUN,
      envelopeId: envOf(env),
      decision,
      by,
      ...extra,
    });
  }

  transfer(from: number, to: number, envelope?: number): this {
    return this.push('edge.transfer', {
      runId: RUN,
      edgeId: '01JBXQ8Z9KQ4R7N2VWXYZ0EDGE',
      fromNodeId: nodeId(from),
      toNodeId: nodeId(to),
      iteration: 1,
      summary: 'text · ~5 tokens',
      ...(envelope === undefined ? {} : { envelopeId: envOf(envelope) }),
    });
  }

  completed(status: 'COMPLETE' | 'HALTED' = 'COMPLETE'): this {
    return this.push('run.completed', {
      runId: RUN,
      status,
      ...(status === 'HALTED' ? { haltReason: 'stopped' } : {}),
      totals: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
    });
  }
}
