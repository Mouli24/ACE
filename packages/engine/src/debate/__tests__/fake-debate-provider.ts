import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { GenerateRequest, ProviderAdapter, StreamChunk } from '../../ports/index.js';

/**
 * The scripted provider every debate test runs on (pre-flight Q5): no env vars, no network.
 *
 * A debate prompt carries no node names (D345), so this keys on the call id the runner puts on
 * `GenerateRequest.turnId` (`<debateId>/<callId>`): `R1-A`, `judge`, `judge-openings`. Each call id
 * counts its own attempts, so a script's first step answers the turn, its second the retry or the
 * repair. Without a script it answers validly, so a test scripts only what it is about.
 */

export interface FakeStep {
  /** An object is sent as a fenced json block after a line of prose; a string is sent as is. */
  reply?: unknown;
  /** Throw, the way a CLI that exited non-zero does. */
  fail?: string;
  /** Hold until the call is aborted. */
  hold?: true;
  /** Write a file into the call's working folder before answering. */
  writeFile?: { name: string; content: string };
  /** What the provider reports; `null` reports nothing (the runner then estimates). */
  usage?: { tokensIn: number; tokensOut: number } | null;
}

export interface FakeCall {
  callId: string;
  attempt: number;
  prompt: string;
  system: string | undefined;
  modelId: string;
  workingDir: string | undefined;
  readOnly: boolean | undefined;
  aborted: boolean;
}

export interface FakeDebateProvider {
  adapter: ProviderAdapter;
  script(callId: string, steps: FakeStep[]): void;
  readonly calls: FakeCall[];
  promptsOf(callId: string): string[];
  /** Resolves once a call with this id (and attempt, when given) has started. */
  whenCalled(callId: string, attempt?: number): Promise<FakeCall>;
}

export interface FakeDebateOptions {
  /** The answer a call gives when no script says otherwise, by call id; `yes` by default. */
  answer?: (callId: string) => string;
}

const TURN = /^R(\d)-([A-E])$/;

/** The previous round's turn ids of the other debaters, as the prompt lists them. */
function othersLastRound(prompt: string): string[] {
  const ids: string[] = [];
  for (const line of prompt.split('\n')) {
    const match = /^\[(R\d-[A-E])\](?! \(you\))/.exec(line);
    if (match?.[1] !== undefined && !line.includes('(no valid turn')) ids.push(match[1]);
  }
  return ids;
}

function firstTurnIdIn(prompt: string): string | undefined {
  return /\[(R\d-[A-E])\]/.exec(prompt)?.[1];
}

export function fenced(value: unknown): string {
  return `Here is my answer.\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`;
}

export function createFakeDebateProvider(options: FakeDebateOptions = {}): FakeDebateProvider {
  const scripts = new Map<string, FakeStep[]>();
  const attempts = new Map<string, number>();
  const calls: FakeCall[] = [];
  const waiters: { callId: string; attempt?: number; resolve: (call: FakeCall) => void }[] = [];
  const answerOf = options.answer ?? (() => 'yes');

  function defaultReply(callId: string, prompt: string): unknown {
    const turn = TURN.exec(callId);
    if (turn !== null) {
      const round = Number(turn[1]);
      const base = {
        answer: answerOf(callId),
        confidence: 0.6,
        reasoning: `Reasoning of ${callId}.`,
      };
      if (round === 0) return base;
      const target = othersLastRound(prompt)[0];
      return {
        ...base,
        rebuttals:
          target === undefined
            ? []
            : [{ targetTurnId: target, claim: 'their claim', response: 'my answer' }],
        positionChanged: false,
        changedBecause: null,
      };
    }
    const cited = firstTurnIdIn(prompt);
    return {
      answer: answerOf(callId),
      confidence: 0.7,
      rationale: [{ point: 'The stronger argument.', supportedBy: [cited ?? 'judge'] }],
      dissent: [],
      openQuestions: [],
    };
  }

  async function* generate(req: GenerateRequest, signal: AbortSignal): AsyncIterable<StreamChunk> {
    const callId = (req.turnId ?? '').split('/').pop() ?? '';
    const attempt = (attempts.get(callId) ?? 0) + 1;
    attempts.set(callId, attempt);
    const call: FakeCall = {
      callId,
      attempt,
      prompt: req.prompt,
      system: req.system,
      modelId: req.modelId,
      workingDir: req.workingDir,
      readOnly: req.readOnly,
      aborted: false,
    };
    calls.push(call);
    for (const waiter of [...waiters]) {
      if (
        waiter.callId === callId &&
        (waiter.attempt === undefined || waiter.attempt === attempt)
      ) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(call);
      }
    }

    const step = scripts.get(callId)?.[attempt - 1] ?? {};
    if (step.writeFile !== undefined && req.workingDir !== undefined) {
      writeFileSync(join(req.workingDir, step.writeFile.name), step.writeFile.content);
    }
    if (step.hold === true) {
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', () => resolve(), { once: true });
      });
      call.aborted = true;
      throw Object.assign(new Error('The call was aborted.'), { name: 'AbortError' });
    }
    if (step.fail !== undefined) {
      throw Object.assign(new Error(step.fail), { status: 503 });
    }

    const text =
      typeof step.reply === 'string'
        ? step.reply
        : fenced(step.reply === undefined ? defaultReply(callId, req.prompt) : step.reply);
    const half = Math.floor(text.length / 2);
    yield { type: 'text', delta: text.slice(0, half) };
    yield { type: 'text', delta: text.slice(half) };
    if (step.usage !== null) {
      const reported = step.usage ?? {
        tokensIn: Math.ceil(req.prompt.length / 4),
        tokensOut: Math.ceil(text.length / 4),
      };
      yield { type: 'usage', tokensIn: reported.tokensIn, tokensOut: reported.tokensOut };
    }
    yield { type: 'finish', reason: 'stop' };
  }

  return {
    adapter: {
      type: 'mock',
      check: async () => ({ status: 'CONNECTED' }),
      listModels: async () => [],
      generate,
    },
    script(callId, steps) {
      scripts.set(callId, steps);
    },
    calls,
    promptsOf: (callId) => calls.filter((c) => c.callId === callId).map((c) => c.prompt),
    whenCalled(callId, attempt) {
      const found = calls.find(
        (c) => c.callId === callId && (attempt === undefined || c.attempt === attempt),
      );
      if (found !== undefined) return Promise.resolve(found);
      return new Promise((resolve) =>
        waiters.push({ callId, ...(attempt === undefined ? {} : { attempt }), resolve }),
      );
    },
  };
}
