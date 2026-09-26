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
  type NodeState,
  type Part,
  type Usage,
  type Verdict,
} from "@ace/contracts";

import { createBatcher } from "../events/batcher.js";
import { classifyError, failureReasonFor, nodeStateFor } from "../errors/index.js";
import type { EventBus } from "../events/index.js";
import type { Logger } from "../logging/index.js";
import type {
  ModelRouter,
  ProviderAdapter,
  StreamChunk,
} from "../ports/index.js";
import { assemblePrompt } from "../prompts/index.js";
import { usageFor } from "./cost.js";
import { runTransform } from "./transform.js";

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
  /**
   * Called once, when the node starts doing its work: for an agent that is the moment it holds its
   * provider's concurrency slot, so a node queued behind the limit stays READY (D66, FR-PRV-009).
   */
  onStarted?: () => Promise<void>;
  /**
   * Called when an agent's provider call ends, still holding the slot — the moment its node run
   * ends, so node-run spans on one provider never overlap more than its limit allows (D66).
   */
  onEnded?: () => void;
  /**
   * The guardrail points for this node run, or absent when the app is built without a guardrail
   * engine — in which case nothing is checked and the executor validates the contract itself, the
   * round-2 behaviour.
   */
  guardrails?: NodeGuardrails;
  /**
   * FR-ERR-005: the validation reason of the attempt this one is repairing, appended to the
   * instructions. Set only on the single contract-repair retry (§2.1).
   */
  repairReason?: string;
}

/**
 * What a guardrail point decided about what was flowing through (FR-GRD-007, FR-GRD-011..015).
 *
 * `continue` carries the content on — possibly rewritten, which is how a `redact` reaches the prompt
 * and the stored output (FR-GRD-014). `failed` names the reason the node run records, so a guardrail
 * block stays `GUARDRAIL_VIOLATION` and a contract failure stays `CONTRACT_VIOLATION` (D9, D85).
 */
export type GuardrailStep<T> =
  | ({ kind: "continue"; verdicts?: Verdict[] } & T)
  | { kind: "failed"; failureReason: FailureReason; error: NodeError; verdicts?: Verdict[] };

/**
 * The guardrail points the executor runs, supplied per node run by the scheduler (Arch §13.1).
 *
 * The executor calls them and does nothing else about guardrails: it does not resolve a policy, does
 * not store a verdict and does not know what `ask_user` means. That matters at the output point in
 * particular — the hook runs *before* `node.output` is emitted, so a masked secret is masked
 * everywhere, including on the socket (BR-07, D86).
 */
export interface NodeGuardrails {
  /** The input point: every envelope's reads, before prompt assembly (FR-GRD-003). */
  beforePrompt(
    envelopes: readonly Envelope[],
  ): Promise<GuardrailStep<{ envelopes: Envelope[] }>>;
  /**
   * The output point, before the contract decides (FR-GRD-007, §4 item 4). When this is wired it
   * **owns** the contract check too, so an output is validated exactly once (D85).
   */
  afterOutput(
    parts: Part[],
    contract?: EnvelopeContract,
  ): Promise<GuardrailStep<{ parts: Part[] }>>;
}

export interface NodeExecutionOutcome {
  /**
   * `NodeState` rather than the two round-2 values: a cancelled node ends `STOPPED`, not `FAILED`
   * (FR-ERR-007), and an upstream that never produced anything leaves this one `BLOCKED`
   * (FR-ERR-006). The state is `nodeStateFor(error)`, which is the one table for it (Arch §19.1).
   */
  status: NodeState;
  output: Part[];
  usage: Usage;
  failureReason?: FailureReason;
  error?: NodeError;
  modelUsed?: ModelUsed;
  prompt?: { version: string; text: string };
  /** Every verdict the points above recorded, in the order they were recorded (FR-GRD-015). */
  verdicts?: Verdict[];
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

/*
 * There is no private classifier here any more: `classifyError` is the one in `../errors/` and the
 * eight kinds of Arch §28 are decided in exactly one place (FR-ERR-001). Two deliberate changes come
 * with it (D109): a `TimeoutError` is `network` and retryable rather than a cancellation — Arch §28
 * groups timeouts with network failures, and `AbortSignal.timeout()` is what raises it — while a bare
 * `AbortError` stays `user_cancelled`; and an HTTP status carried on the thrown error decides.
 */

export function createNodeExecutor(deps: NodeExecutorDeps): NodeExecutor {
  const batchMs = deps.tokenBatchMs ?? TOKEN_BATCH_MS;

  /** A failure, shaped the way the node run row wants it, and announced. */
  async function fail(
    input: ExecuteNodeInput,
    error: NodeError,
    usage: Usage = NO_USAGE,
    extra: Partial<NodeExecutionOutcome> = {},
  ): Promise<NodeExecutionOutcome> {
    const status = extra.status ?? nodeStateFor(error);
    // FR-ERR-007: a node the user stopped has not failed, so it records no failure reason. Writing
    // `RUN_FAILED` beside `STOPPED` is exactly the conflation BR-03 forbids.
    const failureReason =
      extra.failureReason ?? (status === "STOPPED" ? undefined : failureReasonFor(error));

    // A cancellation is not an error frame. `node.error` carries a required `failureReason` and the
    // UI paints one red; a node the user stopped has neither (FR-ERR-007). Its `node.state` frame
    // says `STOPPED`, and the node run still records the `user_cancelled` error behind it.
    if (failureReason !== undefined) {
      await deps.bus.emit({
        type: "node.error",
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
    }

    return {
      output: [],
      usage,
      error,
      ...(failureReason === undefined ? {} : { failureReason }),
      ...extra,
      status,
    };
  }

  async function succeed(
    input: ExecuteNodeInput,
    output: Part[],
    usage: Usage,
    extra: Partial<NodeExecutionOutcome> = {},
  ): Promise<NodeExecutionOutcome> {
    await deps.bus.emit({
      type: "node.output",
      workflowId: input.workflowId,
      runId: input.runId,
      payload: {
        runId: input.runId,
        nodeRunId: input.nodeRunId,
        nodeId: input.node.id,
        output,
        usage,
        ...(extra.modelUsed === undefined
          ? {}
          : { modelUsed: extra.modelUsed }),
      },
    });

    return { status: "COMPLETED", output, usage, ...extra };
  }

  /* ---------------------------------------------------------------- agents */

  async function executeAgent(
    input: ExecuteNodeInput,
  ): Promise<NodeExecutionOutcome> {
    const node = input.node;
    if (node.kind !== "agent" && node.kind !== "model") {
      throw new Error(`executeAgent called for a ${node.kind} node`);
    }
    // Once per node run: a fallback to a second provider waits at that gate too, but the node has
    // already started (D66).
    let starting: Promise<void> | undefined;
    const started = (): Promise<void> =>
      (starting ??= input.onStarted?.() ?? Promise.resolve());

    const instructions =
      node.kind === "agent"
        ? node.config.instructions
        : (node.config.systemPrompt ?? "");
    const contract: EnvelopeContract = {
      outputTypes: node.config.outputTypes,
      ...(node.kind === "agent" &&
      node.config.outputContract?.jsonSchema !== undefined
        ? { jsonSchema: node.config.outputContract.jsonSchema }
        : {}),
      ...(node.config.execution.maxTokens === undefined
        ? {}
        : { maxTokens: node.config.execution.maxTokens }),
    };

    /* The collected verdicts of both points, carried on the outcome for the report (FR-GRD-015). */
    const verdicts: Verdict[] = [];

    /*
     * The input point, before assembly (FR-GRD-003, §4 item 4). It runs here rather than in the
     * scheduler for one reason: a `redact` has to reach the prompt, and the prompt is built on the
     * next line.
     */
    let envelopes = input.envelopes;
    if (input.guardrails !== undefined) {
      const checked = await input.guardrails.beforePrompt(envelopes);
      verdicts.push(...(checked.verdicts ?? []));
      if (checked.kind === "failed") {
        return fail(input, checked.error, NO_USAGE, {
          failureReason: checked.failureReason,
          verdicts,
        });
      }
      envelopes = checked.envelopes;
    }

    const prompt = assemblePrompt({
      // FR-ERR-005 / §2.1: the one contract-repair retry is the same prompt with the validation
      // reason appended, so the model is told what was wrong with its last answer.
      instructions:
        input.repairReason === undefined
          ? instructions
          : `${instructions}\n\nYour previous answer was rejected: ${input.repairReason}\nAnswer again, satisfying the output contract exactly.`,
      envelopes,
      contract,
      iteration: input.iteration,
    });

    /* Route. The router is pure over the catalog and never calls a provider (FR-RTR-006). */
    const catalog = await deps.modelsFor();
    const routing =
      node.kind === "agent"
        ? node.config.routing
        : { policy: "fixed" as const, fallbackModelIds: [] };

    // The `agent | model` narrowing above does not reach inside `attemptWith`, so the two
    // fields it needs are captured here rather than re-narrowed there.
    const outputTypes = node.config.outputTypes;
    const { temperature } = node.config.execution;

    const routingNode = {
      ...(node.config.providerId === undefined
        ? {}
        : { providerId: node.config.providerId }),
      ...(node.config.modelId === undefined
        ? {}
        : { modelId: node.config.modelId }),
      routing,
    };
    const requirements = {
      inputTypes: node.config.inputTypes,
      outputTypes: node.config.outputTypes,
    };

    /**
     * The fallback chain (FR-RTR-002, TC-RTR-002). The router decides *which* model is next; this
     * loop is what asks it again after a failure a different model could survive. Only
     * `provider` and `network` failures come back here — the router itself refuses to move on
     * from anything else, and this stops immediately so the chain is never walked pointlessly.
     *
     * Retry of the *same* model with backoff is round 3; this is moving to the next one.
     */
    const failures: { modelId: string; kind: NodeError["kind"] }[] = [];
    let lastProviderError: NodeError | undefined;
    let lastUsage: Usage = NO_USAGE;
    let lastModelUsed: ModelUsed | undefined;
    const promptRecord = { version: prompt.version, text: prompt.redactedText };

    // One attempt per model in the chain, plus one: the router stops before this ever binds.
    const maxAttempts = 2 + routing.fallbackModelIds.length;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const route = deps.router.resolve(routingNode, requirements, {
        failures,
      });

      if (!route.ok) {
        // TC-RTR-003: when the chain is exhausted the useful answer is what actually went wrong,
        // not "the router ran out of options".
        return lastProviderError === undefined
          ? fail(
              input,
              {
                kind: "invalid_config",
                code: route.code,
                message: route.reason,
                retryable: false,
              },
              NO_USAGE,
              { verdicts: [...verdicts] },
            )
          : fail(input, lastProviderError, lastUsage, {
              ...(lastModelUsed === undefined
                ? {}
                : { modelUsed: lastModelUsed }),
              prompt: promptRecord,
              verdicts: [...verdicts],
            });
      }

      const outcome = await attemptWith(route.route);
      if (outcome.kind === "done") return outcome.result;

      failures.push({ modelId: route.route.modelId, kind: outcome.error.kind });
      lastProviderError = outcome.error;
      lastUsage = outcome.usage;
      lastModelUsed = route.route;
    }

    /* Unreachable in practice: the router refuses before the attempt budget runs out. */
    return fail(
      input,
      lastProviderError ?? {
        kind: "provider",
        code: "no_candidate_left",
        message: "Every model in the routing chain was tried.",
        retryable: false,
      },
      lastUsage,
      { prompt: promptRecord },
    );

    /** One call against one resolved model. */
    async function attemptWith(
      chosen: ModelUsed,
    ): Promise<
      | { kind: "done"; result: NodeExecutionOutcome }
      | { kind: "retryable"; error: NodeError; usage: Usage }
    > {
      const pricing = catalog.find(
        (model) =>
          model.providerId === chosen.providerId &&
          model.modelId === chosen.modelId,
      )?.pricing;

      const modelUsed: ModelUsed = chosen;

      /* Call, inside this provider's concurrency gate. */
      let text = "";
      let jsonValue: unknown;
      let sawJson = false;
      let tokensIn = 0;
      let tokensOut = 0;
      let finishReason: string = "stop";

      const tokens = createBatcher<string>({
        intervalMs: batchMs,
        flush: (deltas) => {
          void deps.bus.emitTransient({
            type: "node.token",
            workflowId: input.workflowId,
            runId: input.runId,
            payload: {
              runId: input.runId,
              nodeRunId: input.nodeRunId,
              delta: deltas.join(""),
            },
          });
        },
      });

      try {
        await deps.runGated(chosen.providerId, async () => {
          await started();
          try {
            await callModel();
          } finally {
            // Still inside the gate: the next node's startedAt can never precede this endedAt.
            input.onEnded?.();
          }
        });

        async function callModel(): Promise<void> {
          const adapter = await deps.adapterFor(chosen.providerId);
          /*
           * `execution.timeoutMs` is the node's own clock, and it starts here — after the provider
           * slot is held, never when the node was queued for it (D66). `AbortSignal.timeout` sets a
           * `TimeoutError` reason, which the adapter reads to raise a retryable `network` failure
           * rather than a cancellation (D97, Arch §28).
           */
          const timeoutMs =
            node.kind === 'agent' || node.kind === 'model' ? node.config.execution.timeoutMs : 0;
          const callSignal =
            timeoutMs > 0
              ? AbortSignal.any([input.signal, AbortSignal.timeout(timeoutMs)])
              : input.signal;

          const stream = adapter.generate(
            {
              modelId: chosen.modelId,
              system: prompt.system,
              prompt: prompt.text,
              outputTypes,
              ...(contract.jsonSchema === undefined
                ? {}
                : { jsonSchema: contract.jsonSchema }),
              ...(contract.maxTokens === undefined
                ? {}
                : { maxTokens: contract.maxTokens }),
              temperature,
              runId: input.runId,
              iteration: input.iteration,
            },
            callSignal,
          );

          for await (const chunk of stream as AsyncIterable<StreamChunk>) {
            switch (chunk.type) {
              case "text":
                text += chunk.delta;
                tokens.push(chunk.delta);
                break;
              case "json":
                jsonValue = chunk.value;
                sawJson = true;
                break;
              case "usage":
                tokensIn = chunk.tokensIn;
                tokensOut = chunk.tokensOut;
                break;
              case "finish":
                finishReason = chunk.reason;
                break;
            }
          }
        }
      } catch (error) {
        tokens.stop();
        const nodeError = classifyError(error);
        const usage = usageFor(tokensIn, tokensOut, pricing);

        // Only these two are worth another model; everything else stops here (FR-RTR-002).
        if (nodeError.kind === "provider" || nodeError.kind === "network") {
          return { kind: "retryable", error: nodeError, usage };
        }

        return {
          kind: "done",
          result: await fail(input, nodeError, usage, {
            modelUsed,
            prompt: promptRecord,
          }),
        };
      }

      tokens.stop();
      const usage = usageFor(tokensIn, tokensOut, pricing);

      /* A refusal is the model declining, which is an `agent` error, not a provider outage. */
      if (finishReason === "refusal") {
        return {
          kind: "done",
          result: await fail(
            input,
            {
              kind: "agent",
              code: "refusal",
              message: `The model declined to answer: ${text.trim()}`,
              retryable: false,
            },
            usage,
            { modelUsed, prompt: promptRecord },
          ),
        };
      }

      /* Collect parts: json when the contract asks for it, text otherwise. */
      const wantsJson = outputTypes.includes("json");
      const output: Part[] = [];

      if (wantsJson) {
        if (sawJson) {
          output.push({ type: "json", value: jsonValue });
        } else {
          try {
            output.push({ type: "json", value: JSON.parse(text.trim()) });
          } catch {
            // BR-03: the model answered, it just answered wrongly. That is a contract violation,
            // never RUN_FAILED, and never a reason to retry a different provider.
            return {
              kind: "done",
              result: await fail(
                input,
                {
                  kind: "agent",
                  code: "contract_violation",
                  message: `The model did not return valid JSON: ${text.trim().slice(0, 120)}`,
                  retryable: false,
                },
                usage,
                {
                  modelUsed,
                  prompt: promptRecord,
                  failureReason: "CONTRACT_VIOLATION",
                },
              ),
            };
          }
        }
      }

      for (const type of outputTypes) {
        if (type === "json") continue;
        if (type === "code")
          output.push({ type: "code", language: "text", text: text.trim() });
        else if (type === "text")
          output.push({ type: "text", text: text.trim() });
      }

      /*
       * The output point (§4 item 4, FR-GRD-007). When a guardrail engine is wired it owns the
       * contract check as well, so the output is validated once and a contract failure is still
       * `CONTRACT_VIOLATION` whatever the policy says (D85). It runs here, outside `runGated` and
       * before `node.output` is emitted: the provider slot is already free for whoever is waiting
       * (D66) and a masked secret is masked on the socket too (BR-07, D86).
       */
      let flowing = output;
      if (input.guardrails !== undefined) {
        const checked = await input.guardrails.afterOutput(flowing, contract);
        verdicts.push(...(checked.verdicts ?? []));
        if (checked.kind === "failed") {
          return {
            kind: "done",
            result: await fail(input, checked.error, usage, {
              modelUsed,
              prompt: promptRecord,
              failureReason: checked.failureReason,
              verdicts: [...verdicts],
            }),
          };
        }
        flowing = checked.parts;
      } else {
        const check = validateAgainstContract(flowing, contract);
        if (!check.ok) {
          return {
            kind: "done",
            result: await fail(
              input,
              {
                kind: "agent",
                code: "contract_violation",
                message: check.reason,
                retryable: false,
              },
              usage,
              {
                modelUsed,
                prompt: promptRecord,
                failureReason: "CONTRACT_VIOLATION",
              },
            ),
          };
        }
      }

      return {
        kind: "done",
        result: await succeed(input, flowing, usage, {
          modelUsed,
          prompt: promptRecord,
          verdicts: [...verdicts],
        }),
      };
    }
  }

  /* ---------------------------------------------------------------- others */

  async function executeOther(
    input: ExecuteNodeInput,
  ): Promise<NodeExecutionOutcome> {
    const node = input.node;
    const reads = readsOf(input.envelopes);

    switch (node.kind) {
      case "input": {
        // FR-NODE-011: what the user typed at start wins over what the config remembers.
        const supplied = input.runInputs[node.id];
        const parts: Part[] =
          supplied !== undefined && supplied.length > 0
            ? supplied
            : node.config.text === undefined || node.config.text === ""
              ? []
              : [{ type: "text", text: node.config.text }];

        /*
         * §4 item 4 puts "the Input node content" at the **input** point, so the content the user
         * typed is checked on the node that produced it, with a verdict that says `input`. The
         * scheduler's adapter routes an Input node's `afterOutput` to `evaluateInput` for exactly
         * this; the executor only knows it has a hook to call before it announces the output.
         */
        if (input.guardrails !== undefined) {
          const checked = await input.guardrails.afterOutput(parts);
          if (checked.kind === "failed") {
            return fail(input, checked.error, NO_USAGE, {
              failureReason: checked.failureReason,
              ...(checked.verdicts === undefined ? {} : { verdicts: checked.verdicts }),
            });
          }
          return succeed(input, checked.parts, NO_USAGE, {
            ...(checked.verdicts === undefined ? {} : { verdicts: checked.verdicts }),
          });
        }

        return succeed(input, parts, NO_USAGE);
      }

      case "output":
        // FR-NODE-012: an Output node is a terminal; what reaches it is the final result.
        return succeed(input, reads, NO_USAGE);

      case "transform": {
        const result = runTransform(node.config, reads);
        if (!result.ok) {
          return fail(input, {
            kind: "workflow",
            code: "transform_failed",
            message: result.reason,
            retryable: false,
          });
        }
        return succeed(input, result.parts, NO_USAGE);
      }

      default:
        // Pre-flight refuses these kinds (§2.7 item 5), so reaching here is an engine bug.
        return fail(input, {
          kind: "invalid_config",
          code: "not_supported_yet",
          message: `A ${node.kind} node cannot be executed by this version.`,
          retryable: false,
        });
    }
  }

  return {
    async execute(input) {
      if (input.node.kind === "agent" || input.node.kind === "model") {
        return executeAgent(input);
      }
      // Nothing to queue for: an input, transform or output node starts the moment it is dispatched.
      await input.onStarted?.();
      return executeOther(input);
    },
  };
}
