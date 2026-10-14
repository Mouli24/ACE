import { isCliProviderType, type Id, type Model, type NodeError, type Usage } from '@ace/contracts';

import { estimateTokens } from '../envelopes/index.js';
import { classifyError } from '../errors/classify.js';
import type {
  ModelRouter,
  ProviderAdapter,
  RoutingNodeConfig,
  StreamChunk,
} from '../ports/index.js';
import { usageFor } from '../runs/cost.js';
import { CLI_SESSION_MIN_TIMEOUT_MS } from '../runs/executor.js';

/**
 * One debate call against one model (D343, D359): routed by the node's own routing config, inside
 * that provider's concurrency gate (FR-PRV-009) — the same three seams the node executor uses —
 * and timed like the executor times a turn: the node's `timeoutMs`, at least the CLI session floor
 * for a coding-agent CLI. The call is stateless: a fresh prompt, a fresh scratch folder, no session.
 */

export interface DebateCallRequest {
  /** The node the call belongs to: the debater, or the hub for the judge. */
  nodeId: string;
  route: RoutingNodeConfig;
  prompt: string;
  /** `<debateId>/<callId>`: a provider keys per-call behaviour on it (the mock, the fakes). */
  turnId: string;
  workingDir: string;
  timeoutMs: number;
  signal: AbortSignal;
  onDelta?: (text: string) => void;
}

export type DebateCallResult =
  | { ok: true; text: string; usage: Usage; providerId: Id; modelId: string }
  | { ok: false; error: NodeError; usage: Usage; cancelled: boolean };

export interface DebateCaller {
  call(request: DebateCallRequest): Promise<DebateCallResult>;
}

export interface DebateCallerDeps {
  adapterFor: (providerId: Id) => Promise<ProviderAdapter>;
  modelsFor: () => Promise<Model[]>;
  runGated: <T>(providerId: Id, fn: () => Promise<T>) => Promise<T>;
  router: ModelRouter;
}

/** A debate reads and writes text: the turn's JSON rides in a fenced block (the brief's parsing rule). */
const TEXT_ONLY = { inputTypes: ['text'], outputTypes: ['text'] } as const;

const NO_USAGE: Usage = { tokensIn: 0, tokensOut: 0, costUsd: 0 };

export function createDebateCaller(deps: DebateCallerDeps): DebateCaller {
  return {
    async call(request) {
      const route = deps.router.resolve(request.route, TEXT_ONLY, { failures: [] });
      if (!route.ok) {
        return {
          ok: false,
          cancelled: false,
          usage: NO_USAGE,
          error: {
            kind: 'invalid_config',
            code: route.code,
            message: route.reason,
            retryable: false,
          },
        };
      }
      const { providerId, modelId } = route.route;
      const catalog = await deps.modelsFor();
      const pricing = catalog.find(
        (m) => m.providerId === providerId && m.modelId === modelId,
      )?.pricing;

      let text = '';
      let reported:
        | { tokensIn: number; tokensOut: number; costUsd?: number; cachedTokensIn?: number }
        | undefined;
      const usageNow = (): Usage => {
        if (reported === undefined) {
          return {
            ...usageFor(estimateTokens(request.prompt), estimateTokens(text), pricing),
            source: 'estimated',
          };
        }
        const priced = usageFor(reported.tokensIn, reported.tokensOut, pricing);
        return {
          ...priced,
          ...(reported.costUsd === undefined
            ? {}
            : { costUsd: reported.costUsd, costSource: 'reported' as const }),
          ...(reported.cachedTokensIn === undefined
            ? {}
            : { cachedTokensIn: reported.cachedTokensIn }),
          source: 'reported',
        };
      };

      try {
        return await deps.runGated(providerId, async (): Promise<DebateCallResult> => {
          if (request.signal.aborted) {
            return { ok: false, cancelled: true, usage: NO_USAGE, error: cancelledError() };
          }
          const adapter = await deps.adapterFor(providerId);
          const timeoutMs =
            request.timeoutMs > 0 && isCliProviderType(adapter.type)
              ? Math.max(request.timeoutMs, CLI_SESSION_MIN_TIMEOUT_MS)
              : request.timeoutMs;
          const signal =
            timeoutMs > 0
              ? AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)])
              : request.signal;
          const stream = adapter.generate(
            {
              modelId,
              prompt: request.prompt,
              outputTypes: ['text'],
              turnId: request.turnId,
              workingDir: request.workingDir,
              readOnly: true,
            },
            signal,
          );
          for await (const chunk of stream as AsyncIterable<StreamChunk>) {
            if (chunk.type === 'text') {
              text += chunk.delta;
              request.onDelta?.(chunk.delta);
            } else if (chunk.type === 'usage') {
              reported = {
                tokensIn: (reported?.tokensIn ?? 0) + chunk.tokensIn,
                tokensOut: (reported?.tokensOut ?? 0) + chunk.tokensOut,
                ...(chunk.costUsd === undefined
                  ? {}
                  : { costUsd: (reported?.costUsd ?? 0) + chunk.costUsd }),
                ...(chunk.cachedTokensIn === undefined
                  ? {}
                  : { cachedTokensIn: (reported?.cachedTokensIn ?? 0) + chunk.cachedTokensIn }),
              };
            } else if (chunk.type === 'json') {
              // A provider that answers in JSON directly: the contract reads the same block.
              text += `\n\`\`\`json\n${JSON.stringify(chunk.value)}\n\`\`\`\n`;
            }
          }
          return { ok: true, text, usage: usageNow(), providerId, modelId };
        });
      } catch (error) {
        const cancelled = request.signal.aborted;
        return {
          ok: false,
          cancelled,
          usage: text === '' && reported === undefined ? NO_USAGE : usageNow(),
          error: cancelled ? cancelledError() : classifyError(error, { providerId }),
        };
      }
    },
  };
}

function cancelledError(): NodeError {
  return {
    kind: 'user_cancelled',
    code: 'aborted',
    message: 'The call was cancelled before it finished.',
    retryable: false,
  };
}
