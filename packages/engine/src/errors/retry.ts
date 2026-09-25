import {
  AUTO_RETRY_POLICY,
  CONTRACT_REPAIR_RETRIES,
  RETRY_BACKOFF_BASE_MS,
  RETRY_BACKOFF_MAX_MS,
  type AutoRetryMode,
  type NodeError,
} from '@ace/contracts';

/**
 * The automatic retry policy (FR-ERR-005, R3 §2.1, Arch §28).
 *
 * The table itself is in `@ace/contracts` (`AUTO_RETRY_POLICY`) so that the engine and the web app
 * cannot disagree about which kinds retry. What lives here is the arithmetic and the counting: how
 * long to wait, and when to stop.
 *
 * §2.1 writes the wait as `500 ms · 2^attempt` capped at 8 s and left the exponent to A3 (D95):
 * the exponent is `attempt - 1`, where `attempt` is the attempt that just failed and is numbered
 * from 1 as `NodeRun.attempt` is. So the first wait is the base, 500 ms, and the sequence is
 * 500 · 1000 · 2000 · 4000 · 8000 · 8000 … There is **no jitter**: one local engine, one user and
 * one provider, so there is no thundering herd to spread out, and a deterministic wait is a wait a
 * test can assert and a user can predict.
 */

/** How long to wait after `attempt` failed, before `attempt + 1` (D95). */
export function backoffDelayMs(
  attempt: number,
  options: { baseMs?: number; maxMs?: number } = {},
): number {
  const baseMs = options.baseMs ?? RETRY_BACKOFF_BASE_MS;
  const maxMs = options.maxMs ?? RETRY_BACKOFF_MAX_MS;
  const exponent = Math.max(0, Math.floor(attempt) - 1);

  // 2 ** exponent overflows to Infinity long before any real retry budget; Math.min handles it.
  return Math.min(maxMs, baseMs * 2 ** exponent);
}

/** Every wait a node with this retry budget would make, in order — for tests and for the UI. */
export function backoffSchedule(
  retries: number,
  options: { baseMs?: number; maxMs?: number } = {},
): number[] {
  return Array.from({ length: Math.max(0, retries) }, (_unused, index) =>
    backoffDelayMs(index + 1, options),
  );
}

/** What the engine does by itself after a failure of this kind (`AUTO_RETRY_POLICY`). */
export function autoRetryMode(kind: NodeError['kind']): AutoRetryMode {
  return AUTO_RETRY_POLICY[kind];
}

export interface AutoRetryInput {
  error: NodeError;
  /** The attempt that just failed, numbered from 1 like `NodeRun.attempt`. */
  attempt: number;
  /** `AgentConfig.execution.retries` — how many automatic retries this node is allowed. */
  maxRetries: number;
  /**
   * Contract repairs already spent on this node run's lineage. Separate from `maxRetries`: §2.1
   * gives a contract failure exactly one repair whatever the retry budget says.
   */
  contractRepairs?: number;
}

export type AutoRetryDecision =
  | { retry: false; mode: AutoRetryMode; reason: string }
  | {
      retry: true;
      mode: AutoRetryMode;
      /** The attempt number the new node run carries (FR-ERR-003: always the old one plus 1). */
      nextAttempt: number;
      delayMs: number;
      /** True for the one contract-repair attempt: the validation reason is appended to the prompt. */
      repairPrompt: boolean;
      reason: string;
    };

/**
 * Whether to retry, and after how long (FR-ERR-005).
 *
 * `auth`, `invalid_config`, `workflow`, `guardrail` and `user_cancelled` are never retried, so
 * `mock-401` makes exactly one attempt. `provider` (429 included) and `network` retry with the
 * backoff above up to `execution.retries`. `agent` gets one contract repair and no more, after
 * which `CONTRACT_VIOLATION` stands (D85).
 */
export function autoRetryDecision(input: AutoRetryInput): AutoRetryDecision {
  const mode = autoRetryMode(input.error.kind);
  const attempt = Math.max(1, Math.floor(input.attempt));

  if (mode === 'never') {
    return { retry: false, mode, reason: `A ${input.error.kind} error is never retried.` };
  }

  if (mode === 'contract_repair') {
    const spent = input.contractRepairs ?? 0;
    if (spent >= CONTRACT_REPAIR_RETRIES) {
      return {
        retry: false,
        mode,
        reason: `The one contract-repair retry has already been used.`,
      };
    }
    return {
      retry: true,
      mode,
      nextAttempt: attempt + 1,
      delayMs: 0,
      repairPrompt: true,
      reason: 'Retrying once with the validation reason appended to the prompt.',
    };
  }

  if (attempt > Math.max(0, Math.floor(input.maxRetries))) {
    return {
      retry: false,
      mode,
      reason: `All ${Math.max(0, Math.floor(input.maxRetries))} automatic retries have been used.`,
    };
  }

  const delayMs = backoffDelayMs(attempt);
  return {
    retry: true,
    mode,
    nextAttempt: attempt + 1,
    delayMs,
    repairPrompt: false,
    reason: `Retrying after ${delayMs} ms (${input.error.kind} error).`,
  };
}
