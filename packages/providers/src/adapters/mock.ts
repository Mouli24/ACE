import type { DataType, ModelPricing } from '@ace/contracts';

import {
  ProviderCallError,
  statusToNodeError,
  type GenerateRequest,
  type ModelInfo,
  type ProviderAdapter,
  type ProviderStatus,
  type StreamChunk,
} from '../adapter.js';

/**
 * The mock provider (FR-PRV-010, round 2 §2.6) — the fixture both sides of the build rely on.
 *
 * Everything here is deterministic: the same prompt always produces the same words, so a test can
 * assert on an exact answer, and `calls()` records every call so "zero provider calls" (BR-08,
 * TC-EXE-003) is assertable rather than assumed.
 */

export const MOCK_PRICE_TABLE_VERSION = 'mock-v1';

const MOCK_PRICING: ModelPricing = {
  inputPer1k: 0.001,
  outputPer1k: 0.002,
  priceTableVersion: MOCK_PRICE_TABLE_VERSION,
};

/** §2.6 delays. Real by default; tests inject an instant `sleep`. */
const TEXT_DELAY_MS = 5;
const SLOW_DELAY_MS = 20;
const TEXT_WORDS = 40;
const SLOW_WORDS = 100;

interface MockModelSpec {
  modelId: string;
  displayName: string;
  inputTypes: DataType[];
  outputTypes: DataType[];
  contextWindow?: number;
  supportsTools?: boolean;
  supportsJson?: boolean;
}

/** The §2.6 table, in its order. `listModels()` returns exactly this. */
const SPECS: readonly MockModelSpec[] = [
  { modelId: 'mock-text', displayName: 'Mock text', inputTypes: ['text'], outputTypes: ['text'] },
  { modelId: 'mock-slow', displayName: 'Mock slow', inputTypes: ['text'], outputTypes: ['text'] },
  {
    modelId: 'mock-json',
    displayName: 'Mock JSON',
    inputTypes: ['text', 'json'],
    outputTypes: ['json'],
    supportsJson: true,
  },
  {
    modelId: 'mock-bad-json',
    displayName: 'Mock malformed JSON',
    inputTypes: ['text'],
    outputTypes: ['json'],
    supportsJson: true,
  },
  { modelId: 'mock-503', displayName: 'Mock 503', inputTypes: ['text'], outputTypes: ['text'] },
  {
    modelId: 'mock-429-then-ok',
    displayName: 'Mock 429 then OK',
    inputTypes: ['text'],
    outputTypes: ['text'],
  },
  { modelId: 'mock-401', displayName: 'Mock 401', inputTypes: ['text'], outputTypes: ['text'] },
  {
    modelId: 'mock-timeout',
    displayName: 'Mock timeout',
    inputTypes: ['text'],
    outputTypes: ['text'],
  },
  {
    modelId: 'mock-refuse',
    displayName: 'Mock refusal',
    inputTypes: ['text'],
    outputTypes: ['text'],
  },
  { modelId: 'mock-leak', displayName: 'Mock leak', inputTypes: ['text'], outputTypes: ['text'] },
  {
    modelId: 'mock-repeat',
    displayName: 'Mock repeat',
    inputTypes: ['text'],
    outputTypes: ['text'],
  },
  {
    modelId: 'mock-reject-twice',
    displayName: 'Mock reject twice',
    inputTypes: ['text', 'json'],
    outputTypes: ['json'],
    supportsJson: true,
  },
  {
    modelId: 'mock-tool',
    displayName: 'Mock tool user',
    inputTypes: ['text'],
    outputTypes: ['text'],
    supportsTools: true,
  },
  {
    modelId: 'mock-vision',
    displayName: 'Mock vision',
    inputTypes: ['text', 'image'],
    outputTypes: ['text'],
  },
  {
    modelId: 'mock-embed',
    displayName: 'Mock embeddings',
    inputTypes: ['text'],
    outputTypes: ['json'],
  },
];

export const MOCK_MODELS: readonly ModelInfo[] = SPECS.map((spec) => ({
  modelId: spec.modelId,
  displayName: spec.displayName,
  inputTypes: spec.inputTypes,
  outputTypes: spec.outputTypes,
  contextWindow: spec.contextWindow ?? 200_000,
  supportsTools: spec.supportsTools ?? false,
  supportsJson: spec.supportsJson ?? false,
  pricing: MOCK_PRICING,
}));

/* -------------------------------------------------------------------------- */
/* Determinism                                                                 */
/* -------------------------------------------------------------------------- */

/** FNV-1a. Small, stable across processes, and good enough to seed a word picker. */
function hash(input: string): number {
  let value = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    value ^= input.charCodeAt(i);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value >>> 0;
}

/** xorshift32 — the same seed always walks the same sequence. */
function seeded(seed: number): () => number {
  let state = seed === 0 ? 0x9e3779b9 : seed;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

const VOCABULARY = [
  'alpha', 'analysis', 'answer', 'apply', 'approach', 'argument', 'balance', 'brief',
  'build', 'clear', 'concise', 'context', 'core', 'detail', 'direct', 'draft',
  'evidence', 'example', 'factor', 'finding', 'focus', 'follow', 'framing', 'goal',
  'idea', 'impact', 'input', 'insight', 'intent', 'issue', 'layer', 'level',
  'measure', 'method', 'motive', 'note', 'object', 'option', 'order', 'outcome',
  'output', 'pattern', 'phase', 'plan', 'point', 'policy', 'premise', 'process',
  'profile', 'proof', 'reason', 'record', 'reply', 'report', 'result', 'review',
  'scope', 'signal', 'source', 'step', 'summary', 'target', 'theme', 'value',
] as const;

/** `count` words chosen by a PRNG seeded from `seed` — the §2.6 "seeded by input hash" rule. */
function words(seed: string, count: number): string[] {
  const next = seeded(hash(seed));
  return Array.from({ length: count }, () => VOCABULARY[Math.floor(next() * VOCABULARY.length)]!);
}

/** §2.6: tokens are the whitespace word count. */
export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length;
}

/* -------------------------------------------------------------------------- */
/* The adapter                                                                 */
/* -------------------------------------------------------------------------- */

/** One recorded call. `endedAt` lets a test prove how many calls overlapped (TC-PRV-009). */
export interface MockCall {
  modelId: string;
  prompt: string;
  runId?: string;
  iteration?: number;
  startedAt: number;
  endedAt?: number;
  failed?: boolean;
}

export interface MockAdapterOptions {
  apiKey?: string;
  baseUrl?: string;
  /** Injected by tests so the §2.6 delays cost nothing. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface MockProviderAdapter extends ProviderAdapter {
  calls(): MockCall[];
  /** Highest number of calls that were ever in flight at once. */
  maxConcurrent(): number;
  reset(): void;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function abortError(): ProviderCallError {
  return new ProviderCallError({
    kind: 'user_cancelled',
    code: 'aborted',
    message: 'The call was cancelled before it finished.',
    retryable: false,
  });
}

/** Rejects the moment the signal aborts, and never resolves otherwise. */
function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    signal.addEventListener('abort', () => reject(abortError()), { once: true });
  });
}

export function createMockAdapter(options: MockAdapterOptions = {}): MockProviderAdapter {
  const sleep = options.sleep ?? realSleep;
  const now = options.now ?? (() => Date.now());

  const log: MockCall[] = [];
  /** `mock-429-then-ok` counts per run, so two runs each get their own two failures. */
  const attemptsPerRun = new Map<string, number>();
  let inFlight = 0;
  let peak = 0;

  async function* body(req: GenerateRequest, signal: AbortSignal): AsyncGenerator<StreamChunk> {
    const tokensIn = countWords(req.prompt);

    const stream = async function* (text: string[], delayMs: number): AsyncGenerator<StreamChunk> {
      for (const word of text) {
        if (signal.aborted) throw abortError();
        await sleep(delayMs);
        yield { type: 'text', delta: `${word} ` };
      }
    };

    const finishText = function* (text: string): Generator<StreamChunk> {
      yield { type: 'usage', tokensIn, tokensOut: countWords(text) };
      yield { type: 'finish', reason: 'stop' };
    };

    switch (req.modelId) {
      case 'mock-text':
      case 'mock-slow':
      case 'mock-repeat': {
        const slow = req.modelId === 'mock-slow';
        // `mock-repeat` ignores the input entirely, which is what makes a loop look stuck (§2.6).
        const seed = req.modelId === 'mock-repeat' ? 'mock-repeat' : req.prompt;
        const text = words(seed, slow ? SLOW_WORDS : TEXT_WORDS);

        yield* stream(text, slow ? SLOW_DELAY_MS : TEXT_DELAY_MS);
        yield* finishText(text.join(' '));
        return;
      }

      case 'mock-json': {
        const value = { echo: req.prompt, verdict: 'approved', score: 8, issues: [] };
        yield { type: 'json', value };
        yield { type: 'usage', tokensIn, tokensOut: countWords(JSON.stringify(value)) };
        yield { type: 'finish', reason: 'stop' };
        return;
      }

      case 'mock-reject-twice': {
        const approved = (req.iteration ?? 1) >= 3;
        const value = {
          echo: req.prompt,
          verdict: approved ? 'approved' : 'changes_requested',
          score: approved ? 9 : 4,
          issues: approved ? [] : ['tighten the argument'],
        };
        yield { type: 'json', value };
        yield { type: 'usage', tokensIn, tokensOut: countWords(JSON.stringify(value)) };
        yield { type: 'finish', reason: 'stop' };
        return;
      }

      case 'mock-bad-json': {
        // Deliberately truncated: the executor must fail to parse it and report
        // CONTRACT_VIOLATION rather than RUN_FAILED (BR-03, TC-EXE-005).
        const text = '{ "oops": ';
        yield { type: 'text', delta: text };
        yield* finishText(text);
        return;
      }

      case 'mock-503':
        throw new ProviderCallError(statusToNodeError(503, 'mock service unavailable'));

      case 'mock-401':
        throw new ProviderCallError(statusToNodeError(401, 'mock invalid api key'));

      case 'mock-429-then-ok': {
        const key = req.runId ?? 'no-run';
        const seen = (attemptsPerRun.get(key) ?? 0) + 1;
        attemptsPerRun.set(key, seen);
        if (seen <= 2) throw new ProviderCallError(statusToNodeError(429, 'mock rate limited'));

        const text = words(req.prompt, TEXT_WORDS);
        yield* stream(text, TEXT_DELAY_MS);
        yield* finishText(text.join(' '));
        return;
      }

      case 'mock-timeout':
        // Yields nothing, ever. The only way out is the AbortSignal.
        await untilAborted(signal);
        return;

      case 'mock-refuse': {
        const text = 'I cannot help with that request.';
        yield { type: 'text', delta: text };
        yield { type: 'usage', tokensIn, tokensOut: countWords(text) };
        yield { type: 'finish', reason: 'refusal' };
        return;
      }

      case 'mock-leak': {
        // A credential-shaped string in model output, for the round 3 leak guardrail. Split so
        // the repository lint rule sees no key-shaped literal (CLAUDE.md §2).
        const fake = `sk-ant-${'api03'}-FAKEFAKEFAKEFAKEFAKE0000`;
        const text = `Use this key to continue: ${fake} and do not share it.`;
        yield { type: 'text', delta: text };
        yield* finishText(text);
        return;
      }

      case 'mock-tool': {
        const text = 'I called the echo tool and it returned the input unchanged.';
        yield { type: 'text', delta: text };
        yield* finishText(text);
        return;
      }

      case 'mock-vision': {
        const artifact = /\[artifact ([^\]]+)\]/.exec(req.prompt)?.[1] ?? 'an unnamed artifact';
        const text = `The image ${artifact} shows a diagram with several labelled boxes.`;
        yield { type: 'text', delta: text };
        yield* finishText(text);
        return;
      }

      case 'mock-embed': {
        const text = 'Use embed() for this model rather than generate().';
        yield { type: 'text', delta: text };
        yield* finishText(text);
        return;
      }

      default:
        throw new ProviderCallError({
          kind: 'invalid_config',
          code: 'unknown_model',
          message: `The mock provider has no model "${req.modelId}".`,
          retryable: false,
        });
    }
  }

  return {
    type: 'mock',

    async check(): Promise<ProviderStatus> {
      const startedAt = now();

      if (options.baseUrl !== undefined && options.baseUrl.includes('unreachable')) {
        return {
          status: 'UNREACHABLE',
          message: `Could not reach ${options.baseUrl}.`,
          latencyMs: now() - startedAt,
        };
      }
      if (options.apiKey === 'bad') {
        return {
          status: 'AUTH_FAILED',
          message: 'The mock provider rejected the key "bad".',
          latencyMs: now() - startedAt,
        };
      }
      if (options.apiKey === 'ratelimited') {
        return {
          status: 'RATE_LIMITED',
          message: 'The mock provider is rate limiting this key.',
          latencyMs: now() - startedAt,
        };
      }

      return { status: 'CONNECTED', latencyMs: now() - startedAt };
    },

    listModels: async () => MOCK_MODELS.map((model) => ({ ...model })),

    /** A call against a model that does not exist is still a call, and is still logged. */
    generate(req, signal) {
      return (async function* (): AsyncGenerator<StreamChunk> {
        const call: MockCall = {
          modelId: req.modelId,
          prompt: req.prompt,
          ...(req.runId === undefined ? {} : { runId: req.runId }),
          ...(req.iteration === undefined ? {} : { iteration: req.iteration }),
          startedAt: now(),
        };
        log.push(call);
        inFlight += 1;
        peak = Math.max(peak, inFlight);

        try {
          yield* body(req, signal);
        } catch (error) {
          call.failed = true;
          throw error;
        } finally {
          call.endedAt = now();
          inFlight -= 1;
        }
      })();
    },

    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((text) => {
        const next = seeded(hash(text));
        return Array.from({ length: 64 }, () => Number((next() * 2 - 1).toFixed(6)));
      });
    },

    calls: () => log.map((call) => ({ ...call })),
    maxConcurrent: () => peak,

    reset() {
      log.length = 0;
      attemptsPerRun.clear();
      peak = 0;
      inFlight = 0;
    },
  };
}
