import {
  validateAgainstContract,
  type Envelope,
  type EnvelopeContract,
  type FailureReason,
  type Id,
  type Model,
  type ModelUsed,
  type Node,
  type NodeError,
  type Part,
  type Usage,
} from '@ace/contracts';

import { createBatcher } from '../events/batcher.js';
import type { EventBus } from '../events/index.js';
import type { Logger } from '../logging/index.js';
import type { ModelRouter, ProviderAdapter, StreamChunk } from '../ports/index.js';
import { assemblePrompt } from '../prompts/index.js';
import { usageFor } from './cost.js';
import { runTransform } from './transform.js';

/**
 * The node executor (FR-EXE-004..010, FR-EXE-015, Arch §12.2).
 *
 * One node run, start to finish: assemble, route, call, stream, check, price. Everything it
 * learns is returned rather than written — the scheduler owns the node run row and the run
 * totals, so there is one writer per row and no interleaving between concurrent nodes.
 */

/** Arch §24: stream frames are batched for about 50 ms before they reach a client. */
export const TOKEN_BATCH_MS = 50;

export interface ExecuteNodeInput {
  runId: Id;
  workflowId: Id;
  nodeRunId: Id;
  node: Node;
  envelopes: readonly Envelope[];
  iteration: number;
  attempt: number;
  /** What `StartRunRequest.inputs` supplied, keyed by Input node id (FR-NODE-011). */
  runInputs: Record<Id, Part[]>;
  signal: AbortSignal;
}

export interface NodeExecutionOutcome {
  status: 'COMPLETED' | 'FAILED';
  output: Part[];
  usage: Usage;
  failureReason?: FailureReason;
  error?: NodeError;
  modelUsed?: ModelUsed;
  prompt?: { version: string; text: string };
}

export interface NodeExecutorDeps {
  bus: EventBus;
  logger: Logger;
  adapterFor: (providerId: Id) => Promise<ProviderAdapter>;
  /** The catalog rows the router chooses from and the executor prices against. */
  modelsFor: () => Promise<Model[]>;
  /** Runs the provider call inside that provider's concurrency gate (FR-PRV-009). */
  runGated: <T>(providerId: Id, fn: () => Promise<T>) => Promise<T>;
  /**
   * Required, and never built here: the router lives in `@ace/providers` and the engine may not
   * import it (CLAUDE.md §3.4 rule 3). A second implementation inside the engine would be a
   * second set of routing rules to keep in step, which is exactly what FR-RTR-002 cannot afford.
   */
  router: ModelRouter;
  now?: () => string;
  tokenBatchMs?: number;
}

export interface NodeExecutor {
  execute(input: ExecuteNodeInput): Promise<NodeExecutionOutcome>;
}

const NO_USAGE: Usage = { tokensIn: 0, tokensOut: 0, costUsd: 0 };

/** Everything an executing node can read: the reads of every envelope delivered to it. */
function readsOf(envelopes: readonly Envelope[]): Part[] {
  return [...envelopes]
    .sort((a, b) => a.fromNodeId.localeCompare(b.fromNodeId))
    .flatMap((envelope) => envelope.reads);
}

/** The error an adapter threw, already mapped, or a generic provider failure. */
function toNodeError(error: unknown): NodeError {
  const mapped = (error as { nodeError?: NodeError }).nodeError;
  if (mapped !== undefined) return mapped;

  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return {
      kind: 'user_cancelled',
      code: 'aborted',
      message: 'The call was cancelled before it finished.',
      retryable: false,
    };
  }

  return {
    kind: 'provider',
    code: 'unknown',
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  };
}

/** Arch §28: an error kind decides the failure reason a node run records (BR-03). */
function failureReasonFor(error: NodeError): FailureReason {
  if (error.kind === 'guardrail') return 'GUARDRAIL_VIOLATION';
  if (error.kind === 'invalid_config' || error.kind === 'workflow') return 'BLOCKED';
  return 'RUN_FAILED';
}

export function createNodeExecutor(deps: NodeExecutorDeps): NodeExecutor {
  const batchMs = deps.tokenBatchMs ?? TOKEN_BATCH_MS;

  /** A failure, shaped the way the node run row wants it, and announced. */
  async function fail(
    input: ExecuteNodeInput,
    error: NodeError,
    usage: Usage = NO_USAGE,
    extra: Partial<NodeExecutionOutcome> = {},
  ): Promise<NodeExecutionOutcome> {
    const failureReason = extra.failureReason ?? failureReasonFor(error);

    await deps.bus.emit({
      type: 'node.error',
      workflowId: input.workflowId,
      runId: input.runId,
      payload: {
        runId: input.runId,
        nodeRunId: input.nodeRunId,
        nodeId: input.node.id,
        error,
        failureReason,
      },
    });

    return { status: 'FAILED', output: [], usage, error, failureReason, ...extra };
  }

  async function succeed(
    input: ExecuteNodeInput,
    output: Part[],
    usage: Usage,
    extra: Partial<NodeExecutionOutcome> = {},
  ): Promise<NodeExecutionOutcome> {
    await deps.bus.emit({
      type: 'node.output',
      workflowId: input.workflowId,
      runId: input.runId,
      payload: {
        runId: input.runId,
        nodeRunId: input.nodeRunId,
        nodeId: input.node.id,
        output,
        usage,
        ...(extra.modelUsed === undefined ? {} : { modelUsed: extra.modelUsed }),
      },
    });

    return { status: 'COMPLETED', output, usage, ...extra };
  }

  /* ---------------------------------------------------------------- agents */

  async function executeAgent(input: ExecuteNodeInput): Promise<NodeExecutionOutcome> {
    const node = input.node;
    if (node.kind !== 'agent' && node.kind !== 'model') {
      throw new Error(`executeAgent called for a ${node.kind} node`);
    }

    const instructions = node.kind === 'agent' ? node.config.instructions : (node.config.systemPrompt ?? '');
    const contract: EnvelopeContract = {
      outputTypes: node.config.outputTypes,
      ...(node.kind === 'agent' && node.config.outputContract?.jsonSchema !== undefined
        ? { jsonSchema: node.config.outputContract.jsonSchema }
        : {}),
      ...(node.config.execution.maxTokens === undefined
        ? {}
        : { maxTokens: node.config.execution.maxTokens }),
    };

    const prompt = assemblePrompt({
      instructions,
      envelopes: input.envelopes,
      contract,
      iteration: input.iteration,
    });

    /* Route. The router is pure over the catalog and never calls a provider (FR-RTR-006). */
    const catalog = await deps.modelsFor();
    const routing =
      node.kind === 'agent' ? node.config.routing : { policy: 'fixed' as const, fallbackModelIds: [] };

    const route = deps.router.resolve(
      {
        ...(node.config.providerId === undefined ? {} : { providerId: node.config.providerId }),
        ...(node.config.modelId === undefined ? {} : { modelId: node.config.modelId }),
        routing,
      },
      { inputTypes: node.config.inputTypes, outputTypes: node.config.outputTypes },
      { failures: [] },
    );

    if (!route.ok) {
      return fail(input, {
        kind: 'invalid_config',
        code: route.code,
        message: route.reason,
        retryable: false,
      });
    }

    const pricing = catalog.find(
      (model) =>
        model.providerId === route.route.providerId && model.modelId === route.route.modelId,
    )?.pricing;

    const modelUsed: ModelUsed = route.route;
    const promptRecord = { version: prompt.version, text: prompt.redactedText };

    /* Call, inside this provider's concurrency gate. */
    let text = '';
    let jsonValue: unknown;
    let sawJson = false;
    let tokensIn = 0;
    let tokensOut = 0;
    let finishReason: string = 'stop';

    const tokens = createBatcher<string>({
      intervalMs: batchMs,
      flush: (deltas) => {
        void deps.bus.emitTransient({
          type: 'node.token',
          workflowId: input.workflowId,
          runId: input.runId,
          payload: { runId: input.runId, nodeRunId: input.nodeRunId, delta: deltas.join('') },
        });
      },
    });

    try {
      await deps.runGated(route.route.providerId, async () => {
        const adapter = await deps.adapterFor(route.route.providerId);
        const stream = adapter.generate(
          {
            modelId: route.route.modelId,
            system: prompt.system,
            prompt: prompt.text,
            outputTypes: node.config.outputTypes,
            ...(contract.jsonSchema === undefined ? {} : { jsonSchema: contract.jsonSchema }),
            ...(contract.maxTokens === undefined ? {} : { maxTokens: contract.maxTokens }),
            temperature: node.config.execution.temperature,
            runId: input.runId,
            iteration: input.iteration,
          },
          input.signal,
        );

        for await (const chunk of stream as AsyncIterable<StreamChunk>) {
          switch (chunk.type) {
            case 'text':
              text += chunk.delta;
              tokens.push(chunk.delta);
              break;
            case 'json':
              jsonValue = chunk.value;
              sawJson = true;
              break;
            case 'usage':
              tokensIn = chunk.tokensIn;
              tokensOut = chunk.tokensOut;
              break;
            case 'finish':
              finishReason = chunk.reason;
              break;
          }
        }
      });
    } catch (error) {
      tokens.stop();
      return fail(input, toNodeError(error), usageFor(tokensIn, tokensOut, pricing), {
        modelUsed,
        prompt: promptRecord,
      });
    }

    tokens.stop();
    const usage = usageFor(tokensIn, tokensOut, pricing);

    /* A refusal is the model declining, which is an `agent` error, not a provider outage. */
    if (finishReason === 'refusal') {
      return fail(
        input,
        {
          kind: 'agent',
          code: 'refusal',
          message: `The model declined to answer: ${text.trim()}`,
          retryable: false,
        },
        usage,
        { modelUsed, prompt: promptRecord },
      );
    }

    /* Collect parts: json when the contract asks for it, text otherwise. */
    const wantsJson = node.config.outputTypes.includes('json');
    const output: Part[] = [];

    if (wantsJson) {
      if (sawJson) {
        output.push({ type: 'json', value: jsonValue });
      } else {
        try {
          output.push({ type: 'json', value: JSON.parse(text.trim()) });
        } catch {
          // BR-03: the model answered, it just answered wrongly. That is a contract violation,
          // never RUN_FAILED, and never a reason to retry a different provider.
          return fail(
            input,
            {
              kind: 'agent',
              code: 'contract_violation',
              message: `The model did not return valid JSON: ${text.trim().slice(0, 120)}`,
              retryable: false,
            },
            usage,
            { modelUsed, prompt: promptRecord, failureReason: 'CONTRACT_VIOLATION' },
          );
        }
      }
    }

    for (const type of node.config.outputTypes) {
      if (type === 'json') continue;
      if (type === 'code') output.push({ type: 'code', language: 'text', text: text.trim() });
      else if (type === 'text') output.push({ type: 'text', text: text.trim() });
    }

    const check = validateAgainstContract(output, contract);
    if (!check.ok) {
      return fail(
        input,
        {
          kind: 'agent',
          code: 'contract_violation',
          message: check.reason,
          retryable: false,
        },
        usage,
        { modelUsed, prompt: promptRecord, failureReason: 'CONTRACT_VIOLATION' },
      );
    }

    return succeed(input, output, usage, { modelUsed, prompt: promptRecord });
  }

  /* ---------------------------------------------------------------- others */

  async function executeOther(input: ExecuteNodeInput): Promise<NodeExecutionOutcome> {
    const node = input.node;
    const reads = readsOf(input.envelopes);

    switch (node.kind) {
      case 'input': {
        // FR-NODE-011: what the user typed at start wins over what the config remembers.
        const supplied = input.runInputs[node.id];
        const parts: Part[] =
          supplied !== undefined && supplied.length > 0
            ? supplied
            : node.config.text === undefined || node.config.text === ''
              ? []
              : [{ type: 'text', text: node.config.text }];

        return succeed(input, parts, NO_USAGE);
      }

      case 'output':
        // FR-NODE-012: an Output node is a terminal; what reaches it is the final result.
        return succeed(input, reads, NO_USAGE);

      case 'transform': {
        const result = runTransform(node.config, reads);
        if (!result.ok) {
          return fail(input, {
            kind: 'workflow',
            code: 'transform_failed',
            message: result.reason,
            retryable: false,
          });
        }
        return succeed(input, result.parts, NO_USAGE);
      }

      default:
        // Pre-flight refuses these kinds (§2.7 item 5), so reaching here is an engine bug.
        return fail(input, {
          kind: 'invalid_config',
          code: 'not_supported_yet',
          message: `A ${node.kind} node cannot be executed by this version.`,
          retryable: false,
        });
    }
  }

  return {
    execute(input) {
      return input.node.kind === 'agent' || input.node.kind === 'model'
        ? executeAgent(input)
        : executeOther(input);
    },
  };
}
