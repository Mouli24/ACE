import type { DataType, ModelPricing } from '@ace/contracts';

import {
  ProviderCallError,
  statusToNodeError,
  type GenerateRequest,
  type ModelInfo,
  type ProducedPart,
  type ProviderAdapter,
  type ProviderStatus,
  type StreamChunk,
  type ToolResult,
} from '../adapter.js';
import { MOCK_MEDIA_TYPES, mockMediaFixture } from './mock-media.js';
import {
  isSummaryCall,
  mockCiteAnswer,
  mockEmbed,
  mockMemoryValue,
  mockSummaryText,
} from './mock-rag.js';

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
    modelId: 'mock-reject-always',
    displayName: 'Mock reject always',
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
    modelId: 'mock-tool-loop',
    displayName: 'Mock endless tool user',
    inputTypes: ['text'],
    outputTypes: ['text'],
    supportsTools: true,
  },
  {
    modelId: 'mock-destructive',
    displayName: 'Mock destructive tool user',
    inputTypes: ['text'],
    outputTypes: ['text'],
    supportsTools: true,
  },
  {
    modelId: 'mock-http',
    displayName: 'Mock HTTP tool user',
    inputTypes: ['text'],
    outputTypes: ['text'],
    supportsTools: true,
  },
  {
    modelId: 'mock-search',
    displayName: 'Mock search tool user',
    inputTypes: ['text'],
    outputTypes: ['text'],
    supportsTools: true,
  },
  {
    modelId: 'mock-mcp',
    displayName: 'Mock MCP tool user',
    inputTypes: ['text'],
    outputTypes: ['text'],
    supportsTools: true,
  },
  {
    // D-068: the lever TC-TOOL-004/005 need — code_sandbox with the code the input names.
    modelId: 'mock-sandbox',
    displayName: 'Mock code sandbox user',
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
    modelId: 'mock-media',
    displayName: 'Mock multimodal output',
    inputTypes: ['text'],
    outputTypes: ['text', 'json', 'code', 'image', 'audio', 'video', 'file'],
    supportsJson: true,
  },
  {
    modelId: 'mock-chat',
    displayName: 'Mock chat',
    inputTypes: ['text'],
    outputTypes: ['text'],
  },
  {
    modelId: 'mock-embed',
    displayName: 'Mock embeddings',
    inputTypes: ['text'],
    outputTypes: ['json'],
  },
  // Round 5 §2.10.
  { modelId: 'mock-cite', displayName: 'Mock cite', inputTypes: ['text'], outputTypes: ['text'] },
  {
    modelId: 'mock-memory',
    displayName: 'Mock memory',
    inputTypes: ['text'],
    outputTypes: ['json'],
    supportsJson: true,
  },
  {
    modelId: 'mock-summary',
    displayName: 'Mock summary',
    inputTypes: ['text'],
    outputTypes: ['text'],
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
/* Tool-using and multimodal helpers (round 4 §2.6)                            */
/* -------------------------------------------------------------------------- */

/** Crockford base32, the ULID alphabet (IdSchema, `ULID_REGEX`). */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * A deterministic ULID-shaped id from a seed. The mock cannot mint real ids — it has no store — so
 * a tool call and a produced-media artifact get a stable, `IdSchema`-valid placeholder instead, and
 * the same seed always yields the same id. The engine that stores the bytes assigns the real id.
 */
function deterministicId(seed: string): string {
  const next = seeded(hash(seed));
  // The first character is the high bits of a ULID timestamp: 0–7 only.
  let id = CROCKFORD[Math.floor(next() * 8)]!;
  for (let i = 1; i < 26; i += 1) id += CROCKFORD[Math.floor(next() * CROCKFORD.length)]!;
  return id;
}

/** The first http(s) URL in a piece of text, or a harmless localhost default when there is none. */
function firstUrl(text: string): string {
  return /https?:\/\/[^\s"'<>)\]}]+/.exec(text)?.[0] ?? 'http://localhost/';
}

/**
 * The `path:` line of `mock-destructive`'s input (D-068): a line that starts with `path:`, its value
 * trimmed. `undefined` when no line names a non-empty path — then §2.6's `notes.txt` stands.
 */
function namedPath(text: string): string | undefined {
  const value = /^path:(.*)$/m.exec(text.replace(/\r\n/g, '\n'))?.[1]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

const SANDBOX_LANGUAGE_NAMES = ['javascript', 'python', 'shell'] as const;

/** What `mock-sandbox` answers when its input does not follow the format — it never guesses. */
const SANDBOX_FORMAT_HELP =
  'mock-sandbox needs a `language:` line (javascript, python or shell), an optional `timeoutMs:` ' +
  'line (a positive integer), then one fenced code block.';

/**
 * `mock-sandbox`'s input format (D-068), read from the prompt it is given — the Input node's text
 * sits in the prompt's `## Input` section verbatim:
 *
 * ```text
 * language: javascript            ← required: javascript | python | shell, at the start of a line
 * timeoutMs: 1000                 ← optional: a positive integer, at the start of a line
 * ```js                           ← the first fence that opens after the language line
 * while (true) {}                 ← the code, verbatim, every line up to …
 * ```                             ← … the next line that is exactly three backticks
 * ```
 *
 * Strict on purpose: no `language:` line, a language the sandbox has not got, a malformed
 * `timeoutMs:`, or no complete fenced block after the language line → `undefined`, and the mock
 * answers {@link SANDBOX_FORMAT_HELP} instead of requesting anything.
 */
export function parseSandboxRequest(
  text: string,
): { language: (typeof SANDBOX_LANGUAGE_NAMES)[number]; code: string; timeoutMs?: number } | undefined {
  const lines = text.replace(/\r\n/g, '\n').split('\n');

  const languageAt = lines.findIndex((line) => /^language:/.test(line));
  if (languageAt === -1) return undefined;
  const language = SANDBOX_LANGUAGE_NAMES.find(
    (name) => name === lines[languageAt]?.slice('language:'.length).trim(),
  );
  if (language === undefined) return undefined;

  const open = lines.findIndex((line, index) => index > languageAt && line.startsWith('```'));
  if (open === -1) return undefined;
  const close = lines.findIndex((line, index) => index > open && line === '```');
  if (close === -1) return undefined;

  // Only a `timeoutMs:` line between the language line and the fence counts — never one in the code.
  let timeoutMs: number | undefined;
  const timeoutLine = lines
    .slice(languageAt + 1, open)
    .find((line) => /^timeoutMs:/.test(line));
  if (timeoutLine !== undefined) {
    const raw = timeoutLine.slice('timeoutMs:'.length).trim();
    if (!/^\d+$/.test(raw) || Number(raw) <= 0) return undefined;
    timeoutMs = Number(raw);
  }

  const code = lines.slice(open + 1, close).join('\n');
  return timeoutMs === undefined ? { language, code } : { language, code, timeoutMs };
}

/** The result the executor fed back for a named tool, if any (round 4 §2.6). */
function resultFor(req: GenerateRequest, name: string): ToolResult | undefined {
  return (req.toolResults ?? []).find((entry) => entry.name === name);
}

/** Whether any tool result at all has come back, so a one-shot tool user knows to answer. */
function hasAnyResult(req: GenerateRequest): boolean {
  return (req.toolResults ?? []).length > 0;
}

/**
 * How a media `Part` reference is rendered into an assembled prompt so an adapter can read its
 * metadata — name, size, mime — without ever seeing the bytes (FR-MM-004, BR-02). The engine's
 * prompt manager renders image/audio/video/file reads in this shape, and `mock-vision` parses it
 * back, so the two stay in step through one exported function rather than a convention repeated in
 * two packages.
 */
export function formatArtifactReference(part: {
  type: 'image' | 'audio' | 'video' | 'file';
  name: string;
  size: number;
  mime: string;
}): string {
  return `[${part.type} ${part.name} (${part.size} bytes, ${part.mime})]`;
}

/** A short, deterministic string describing a tool result, for the model's final answer. */
function describeResult(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result !== null && typeof result === 'object') {
    const text = (result as { text?: unknown }).text;
    if (typeof text === 'string') return text;
    return JSON.stringify(result);
  }
  return JSON.stringify(result);
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
  /** The call's system text, when it had one — how a test tells the summariser's call apart. */
  system?: string;
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
  /**
   * This mock as one provider row sees it: `check()` answers §2.6 from that row's `apiKey` and
   * `baseUrl`, while generation, the call log and the per-run counters stay shared (D-025).
   */
  forProvider(row: Pick<MockAdapterOptions, 'apiKey' | 'baseUrl'>): ProviderAdapter;
  calls(): MockCall[];
  /** Highest number of calls that were ever in flight at once. */
  maxConcurrent(): number;
  reset(): void;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Why the caller aborted, as far as the abort reason says.
 *
 * A bare `controller.abort()` is a user stop — `user_cancelled`, never retried (Arch §28). An
 * abort whose reason is a `TimeoutError` is the caller giving up on a provider that went quiet,
 * which is a `network` failure and *is* retryable: `AbortSignal.timeout(execution.timeoutMs)`,
 * alone or inside `AbortSignal.any([...])`, sets exactly that reason, so `mock-timeout` can drive
 * the `network` error kind without the port growing a field (round 3 §4 item 2).
 */
function abortError(signal?: AbortSignal): ProviderCallError {
  const reason: unknown = signal?.reason;
  const name =
    typeof reason === 'object' && reason !== null ? (reason as { name?: unknown }).name : undefined;

  if (name === 'TimeoutError') {
    return new ProviderCallError({
      kind: 'network',
      code: 'timeout',
      message: 'The provider produced nothing before the call timed out.',
      retryable: true,
    });
  }

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
      reject(abortError(signal));
      return;
    }
    signal.addEventListener('abort', () => reject(abortError(signal)), { once: true });
  });
}

/**
 * Wait `ms`, or give up the instant the signal aborts — whichever comes first.
 *
 * Every await inside `generate()` goes through this, which is what makes `POST /runs/:id/stop`
 * cancel a call in the millisecond it is issued rather than at the next token boundary
 * (FR-CTL-003: streams closed within 2 s, and `mock-slow` alone sleeps 100 x 20 ms). The abort
 * listener is dropped when the timer wins, so a completed stream leaves nothing attached to a
 * signal that may abort later.
 */
function pause(
  ms: number,
  signal: AbortSignal,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError(signal));

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      reject(abortError(signal));
    };

    const finish = (settle: () => void): void => {
      signal.removeEventListener('abort', onAbort);
      if (settled) return;
      settled = true;
      settle();
    };

    signal.addEventListener('abort', onAbort, { once: true });
    void sleep(ms).then(
      () => finish(resolve),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

export function createMockAdapter(options: MockAdapterOptions = {}): MockProviderAdapter {
  const sleep = options.sleep ?? realSleep;
  const now = options.now ?? (() => Date.now());

  const log: MockCall[] = [];
  /**
   * How many times each *call* has been made, and how many times each *node* has been called.
   *
   * The port hands an adapter a run and a loop iteration but no node id, so the mock keys its
   * attempt-dependent behaviours on what it does get. An automatic retry re-sends the identical
   * prompt (round 3 §2.1), so (run, model, prompt) is one node's attempt series — which is what
   * `mock-429-then-ok` counts. (run, model) is one node's whole call history, the fallback
   * `mock-reject-twice` uses when the caller sends no `iteration`.
   */
  const attempts = new Map<string, number>();
  const callsPerNode = new Map<string, number>();
  let inFlight = 0;
  let peak = 0;
  /** Bumped for every `tool_call` chunk, so repeated requests get distinct (still stable) ids. */
  let toolCallSeq = 0;

  /** Next attempt number for this exact call: 1 the first time, 2 on the first retry. */
  const nextAttempt = (req: GenerateRequest): number => {
    const key = `${req.runId ?? 'no-run'}|${req.modelId}|${hash(req.prompt)}`;
    const attempt = (attempts.get(key) ?? 0) + 1;
    attempts.set(key, attempt);
    return attempt;
  };

  /**
   * Which loop iteration this is. `iteration` from the caller when there is one (1-based, Arch
   * §12.4); otherwise the nth call to this model in this run, so a review model still walks its
   * script when a caller leaves the field out.
   */
  const nextIteration = (req: GenerateRequest): number => {
    const key = `${req.runId ?? 'no-run'}|${req.modelId}`;
    const nth = (callsPerNode.get(key) ?? 0) + 1;
    callsPerNode.set(key, nth);
    return req.iteration ?? nth;
  };

  async function* body(req: GenerateRequest, signal: AbortSignal): AsyncGenerator<StreamChunk> {
    const tokensIn = countWords(req.prompt);
    // Counted on every call, whichever model it is, so the two numbers mean the same thing for
    // all of them and a model that ignores one still advances it for the next.
    const attempt = nextAttempt(req);
    const iteration = nextIteration(req);

    const stream = async function* (text: string[], delayMs: number): AsyncGenerator<StreamChunk> {
      for (const word of text) {
        await pause(delayMs, signal, sleep);
        yield { type: 'text', delta: `${word} ` };
      }
    };

    const finishText = function* (text: string): Generator<StreamChunk> {
      yield { type: 'usage', tokensIn, tokensOut: countWords(text) };
      yield { type: 'finish', reason: 'stop' };
    };

    /** A whole final answer in one text chunk, then usage and a `stop` finish. */
    const answer = function* (text: string): Generator<StreamChunk> {
      yield { type: 'text', delta: text };
      yield* finishText(text);
    };

    /**
     * Ask the executor to run a tool (round 4 §2.6, Arch §12.7). The turn ends on `tool_calls`, so
     * the executor knows to run the tool and call `generate()` again with the result in
     * `toolResults` rather than treating the stream as a final answer.
     */
    const requestTool = function* (name: string, args: unknown): Generator<StreamChunk> {
      toolCallSeq += 1;
      yield {
        type: 'tool_call',
        callId: deterministicId(`${req.modelId}:${name}:${toolCallSeq}`),
        name,
        args,
      };
      yield { type: 'usage', tokensIn, tokensOut: 0 };
      yield { type: 'finish', reason: 'tool_calls' };
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
        const approved = iteration >= 3;
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

      case 'mock-reject-always': {
        // The §2.4 ReviewContract and nothing else, byte for byte on every call: a Review->Fix
        // loop on this model can only end at its maximum (round 3 §4 item 8, `review-never`).
        const value = { score: 4, verdict: 'changes_requested', issues: ['needs work'] };
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
        if (attempt <= 2) throw new ProviderCallError(statusToNodeError(429, 'mock rate limited'));

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
        // §2.6: request `echo { text: <input> }` once, then answer "echo said: <result>".
        const echoed = resultFor(req, 'echo');
        if (echoed === undefined) {
          yield* requestTool('echo', { text: req.prompt });
          return;
        }
        yield* answer(`echo said: ${describeResult(echoed.result)}`);
        return;
      }

      case 'mock-tool-loop': {
        // §2.6: requests `echo` forever — even when asked to finish without tools, which is what
        // drives the tool-call-limit path to RUN_FAILED once the loop stops it (§2.2, TC-GRD-014).
        yield* requestTool('echo', { text: req.prompt });
        return;
      }

      case 'mock-destructive': {
        // §2.6: request `sandbox_delete { path: 'notes.txt' }`, then answer. D-068: a `path:` line in
        // the input names another path (TC-GRD-006's `../../x`); without one, `notes.txt` as ever.
        const deleted = resultFor(req, 'sandbox_delete');
        if (deleted === undefined) {
          yield* requestTool('sandbox_delete', { path: namedPath(req.prompt) ?? 'notes.txt' });
          return;
        }
        yield* answer(`sandbox_delete returned: ${describeResult(deleted.result)}`);
        return;
      }

      case 'mock-sandbox': {
        // D-068: request `code_sandbox { language, code, timeoutMs? }` from the input (the format is
        // `parseSandboxRequest`'s), then answer with the result's status and exit code.
        const ran = resultFor(req, 'code_sandbox');
        if (ran !== undefined) {
          const result =
            ran.result !== null && typeof ran.result === 'object'
              ? (ran.result as { status?: unknown; exitCode?: unknown })
              : {};
          const status = typeof result.status === 'string' ? result.status : 'ok';
          const exitCode = typeof result.exitCode === 'number' ? String(result.exitCode) : 'none';
          yield* answer(`code_sandbox returned status ${status}, exitCode ${exitCode}.`);
          return;
        }
        const request = parseSandboxRequest(req.prompt);
        if (request === undefined) {
          yield* answer(SANDBOX_FORMAT_HELP);
          return;
        }
        yield* requestTool('code_sandbox', request);
        return;
      }

      case 'mock-http': {
        // §2.6: GET the first URL in the input, then answer with the status it returned.
        const responded = resultFor(req, 'http_request');
        if (responded === undefined) {
          yield* requestTool('http_request', { method: 'GET', url: firstUrl(req.prompt) });
          return;
        }
        const status =
          responded.result !== null && typeof responded.result === 'object'
            ? (responded.result as { status?: unknown }).status
            : undefined;
        yield* answer(`The request returned status ${JSON.stringify(status)}.`);
        return;
      }

      case 'mock-search': {
        // §2.6: web_search on the input, then web_fetch on the first result, then answer.
        const fetched = resultFor(req, 'web_fetch');
        if (fetched !== undefined) {
          const title =
            fetched.result !== null && typeof fetched.result === 'object'
              ? (fetched.result as { title?: unknown }).title
              : undefined;
          yield* answer(`The top result was ${JSON.stringify(title ?? 'a page')}.`);
          return;
        }
        const searched = resultFor(req, 'web_search');
        if (searched !== undefined) {
          const results =
            searched.result !== null && typeof searched.result === 'object'
              ? (searched.result as { results?: unknown }).results
              : undefined;
          const firstResult = Array.isArray(results) ? (results[0] as unknown) : undefined;
          const url =
            firstResult !== null && typeof firstResult === 'object'
              ? (firstResult as { url?: unknown }).url
              : undefined;
          yield* requestTool('web_fetch', {
            url: typeof url === 'string' ? url : firstUrl(req.prompt),
          });
          return;
        }
        yield* requestTool('web_search', { query: req.prompt });
        return;
      }

      case 'mock-mcp': {
        // §2.6: call the first enabled tool whose name starts with `mcp_`, then answer.
        if (hasAnyResult(req)) {
          yield* answer('The MCP tool answered and I have what I need.');
          return;
        }
        const mcpTool = (req.tools ?? []).find((tool) => tool.name.startsWith('mcp_'));
        if (mcpTool === undefined) {
          yield* answer('No MCP tool is available to call.');
          return;
        }
        yield* requestTool(mcpTool.name, {});
        return;
      }

      case 'mock-vision': {
        // §2.6: text+image → "Image <name> (<size> bytes, <mime>)", read from the reference the
        // prompt carries (FR-MM-004: metadata, never bytes). `formatArtifactReference` is the shape.
        const ref = /\[(?:image|audio|video|file) (.+?) \((\d+) bytes, ([^)]+)\)\]/.exec(req.prompt);
        if (ref !== null) {
          yield* answer(`Image ${ref[1]} (${ref[2]} bytes, ${ref[3]})`);
          return;
        }
        // A bare `[artifact NAME]` reference carries only the name; keep the sentence shape.
        const name = /\[artifact ([^\]]+)\]/.exec(req.prompt)?.[1] ?? 'unknown';
        yield* answer(`Image ${name} (0 bytes, application/octet-stream)`);
        return;
      }

      case 'mock-media': {
        // §2.6: one Part of each of the seven data types. The four media Parts are real files —
        // a PNG, an MP3, an MP4 and a ZIP (`mock-media.ts`) — whose bytes ride *beside* each Part
        // for the engine to store as an artifact (FR-MM-003, D-082). The Part stays a reference
        // (FR-MM-004): the mock cannot store bytes itself, so it carries a deterministic,
        // IdSchema-valid placeholder id the engine replaces with the stored artifact's.
        const produced: ProducedPart[] = [
          { part: { type: 'text', text: 'Mock multimodal output.' } },
          { part: { type: 'json', value: { kind: 'mock-media', ok: true } } },
          { part: { type: 'code', language: 'javascript', text: 'export const answer = 42;' } },
          ...MOCK_MEDIA_TYPES.map((type): ProducedPart => {
            const { mime, name, bytes } = mockMediaFixture(type);
            const artifactId = deterministicId(`mock-media:${type}`);
            return { part: { type, artifactId, mime, name, size: bytes.byteLength }, bytes };
          }),
        ];

        let tokensOut = 0;
        for (const { part, bytes } of produced) {
          yield bytes === undefined ? { type: 'part', part } : { type: 'part', part, bytes };
          tokensOut += part.type === 'text' || part.type === 'code' ? countWords(part.text) : 1;
        }
        yield { type: 'usage', tokensIn, tokensOut };
        yield { type: 'finish', reason: 'stop' };
        return;
      }

      case 'mock-chat': {
        // §2.6: "You said: <input>", streamed word by word (FR-CHAT-006); French when the agent's
        // instructions ask for it. Instructions may sit in the system section or the prompt body.
        const french = `${req.system ?? ''}\n${req.prompt}`
          .toLowerCase()
          .includes('answer in french');
        const text = french ? `Vous avez dit : ${req.prompt}` : `You said: ${req.prompt}`;

        yield* stream(text.split(' '), TEXT_DELAY_MS);
        yield* finishText(text);
        return;
      }

      case 'mock-embed': {
        const text = 'Use embed() for this model rather than generate().';
        yield { type: 'text', delta: text };
        yield* finishText(text);
        return;
      }

      case 'mock-cite': {
        yield* answer(mockCiteAnswer(req.prompt));
        return;
      }

      case 'mock-memory': {
        const value = mockMemoryValue(req.prompt);
        yield { type: 'json', value };
        yield { type: 'usage', tokensIn, tokensOut: countWords(JSON.stringify(value)) };
        yield { type: 'finish', reason: 'stop' };
        return;
      }

      case 'mock-summary': {
        // The summariser's call (its system text carries the prompt-version marker): the first 30
        // words of the input. Any other call answers like `mock-text`.
        if (isSummaryCall(req.system)) {
          yield* answer(mockSummaryText(req.prompt));
          return;
        }
        const text = words(req.prompt, TEXT_WORDS);
        yield* stream(text, TEXT_DELAY_MS);
        yield* finishText(text.join(' '));
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

  /** §2.6's provider-level answers, from whichever row is asking. */
  async function checkAs(
    row: Pick<MockAdapterOptions, 'apiKey' | 'baseUrl'>,
  ): Promise<ProviderStatus> {
    const startedAt = now();

    if (row.baseUrl !== undefined && row.baseUrl.includes('unreachable')) {
      return {
        status: 'UNREACHABLE',
        message: `Could not reach ${row.baseUrl}.`,
        latencyMs: now() - startedAt,
      };
    }
    if (row.apiKey === 'bad') {
      return {
        status: 'AUTH_FAILED',
        message: 'The mock provider rejected the key "bad".',
        latencyMs: now() - startedAt,
      };
    }
    if (row.apiKey === 'ratelimited') {
      return {
        status: 'RATE_LIMITED',
        message: 'The mock provider is rate limiting this key.',
        latencyMs: now() - startedAt,
      };
    }

    return { status: 'CONNECTED', latencyMs: now() - startedAt };
  }

  const adapter: MockProviderAdapter = {
    type: 'mock',

    check: () => checkAs(options),

    listModels: async () => MOCK_MODELS.map((model) => ({ ...model })),

    /** A call against a model that does not exist is still a call, and is still logged. */
    generate(req, signal) {
      return (async function* (): AsyncGenerator<StreamChunk> {
        const call: MockCall = {
          modelId: req.modelId,
          prompt: req.prompt,
          ...(req.runId === undefined ? {} : { runId: req.runId }),
          ...(req.iteration === undefined ? {} : { iteration: req.iteration }),
          ...(req.system === undefined ? {} : { system: req.system }),
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

    /** Round 5 §2.10: token hashing with a synonym table; the model id is ignored. */
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((text) => mockEmbed(text));
    },

    calls: () => log.map((call) => ({ ...call })),
    maxConcurrent: () => peak,

    reset() {
      log.length = 0;
      attempts.clear();
      callsPerNode.clear();
      peak = 0;
      inFlight = 0;
      toolCallSeq = 0;
    },

    forProvider: (row) => ({
      type: 'mock',
      check: () => checkAs(row),
      listModels: adapter.listModels,
      generate: adapter.generate,
      embed: adapter.embed,
    }),
  };

  return adapter;
}
