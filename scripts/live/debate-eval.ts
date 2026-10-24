/**
 * Does debate beat one agent? The falsification run for Debate (Phase 2, D340–D359).
 *
 *   pnpm exec tsx scripts/live/debate-eval.ts [--questions bench/debate/questions.jsonl]
 *        [--single claude|codex|gemini] [--rounds 1-4] [--limit N] [--fake]
 *
 * LIVE: it runs the real CLIs (Claude Code, Codex, Gemini), signed in as whoever is signed in, and
 * spends real tokens. It never runs in `pnpm test`. `--fake` runs the same script on the mock
 * provider's `mock-debate` model instead: no CLI, no network, no cost — a smoke run of the script.
 *
 * For each question with options (a free-form question is skipped and counted as skipped):
 *   SINGLE        one call to one provider with the opening contract;
 *   OPENINGS VOTE the debate's own openings majority (DB9), computed in code, free;
 *   DEBATE        a full debate: claude, codex and gemini debate, claude judges, choice mode.
 * Scoring is exact match after trimming and lower-casing.
 *
 * It prints a table per arm (accuracy, mean tokens, mean wall time), the questions the debate
 * fixed (openings majority wrong, verdict right) and broke (openings right, verdict wrong), and
 * debate vs single wins / losses / ties, and writes everything to bench/debate/results-<ts>.json.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import {
  normaliseAnswer,
  type CliDetection,
  type DebateRecord,
  type DebateVerdict,
} from '../../packages/contracts/src/index.js';
import {
  createDebateCaller,
  createSemaphore,
  lastJsonBlock,
  newId,
  openingPrompt,
  runDebate,
  validateTurnReply,
  type EngineEvent,
  type EventBus,
  type ProviderAdapter,
} from '../../packages/engine/src/index.js';
import {
  createClaudeCodeAdapter,
  createCodexAdapter,
  createGeminiAdapter,
  createMockAdapter,
} from '../../packages/providers/src/index.js';
import { createDebateWorkspace } from '../../packages/tools/src/index.js';

const { values } = parseArgs({
  options: {
    questions: { type: 'string', default: 'bench/debate/questions.jsonl' },
    single: { type: 'string', default: 'claude' },
    rounds: { type: 'string', default: '2' },
    limit: { type: 'string' },
    fake: { type: 'boolean', default: false },
  },
});

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_DIR = join(ROOT, 'bench', 'debate');

type Who = 'claude' | 'codex' | 'gemini';
const WHO: readonly Who[] = ['claude', 'codex', 'gemini'];
if (!WHO.includes(values.single as Who)) throw new Error(`--single must be one of ${WHO.join(', ')}.`);
const single = values.single as Who;
const maxRounds = Number(values.rounds);
if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 4) throw new Error('--rounds must be 1–4.');

/** Provider ids are ids like any other (D357); one per CLI. */
const PROVIDER_ID: Record<Who, string> = {
  claude: '01JP0000000000000000000001',
  codex: '01JP0000000000000000000002',
  gemini: '01JP0000000000000000000003',
};

/* -------------------------------------------------------------------------- */
/* Questions                                                                   */
/* -------------------------------------------------------------------------- */

interface Question {
  id: string;
  question: string;
  options?: string[];
  answer: string;
  sample?: boolean;
}

function loadQuestions(path: string): Question[] {
  const lines = readFileSync(join(ROOT, path), 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('//'));
  return lines.map((line, index) => {
    const raw = JSON.parse(line) as Partial<Question>;
    if (typeof raw.id !== 'string' || typeof raw.question !== 'string' || typeof raw.answer !== 'string') {
      throw new Error(`${path} line ${index + 1}: needs id, question and answer strings.`);
    }
    if (raw.options !== undefined && (!Array.isArray(raw.options) || raw.options.length < 2)) {
      throw new Error(`${path} line ${index + 1}: options, when given, need at least two entries.`);
    }
    return raw as Question;
  });
}

/* -------------------------------------------------------------------------- */
/* Providers                                                                   */
/* -------------------------------------------------------------------------- */

const signedIn = (type: CliDetection['type']): (() => Promise<CliDetection>) => async () => ({
  type,
  installed: true,
  login: 'signed_in',
  installHint: '',
  loginHint: '',
});

function adapters(): Record<Who, ProviderAdapter> {
  if (values.fake) {
    const mock = createMockAdapter();
    return { claude: mock, codex: mock, gemini: mock };
  }
  return {
    claude: createClaudeCodeAdapter({ permission: 'read_only', detect: signedIn('claude_code') }),
    codex: createCodexAdapter({ permission: 'read_only', detect: signedIn('codex') }),
    gemini: createGeminiAdapter({ permission: 'read_only', detect: signedIn('gemini') }),
  };
}

const MODEL = values.fake ? 'mock-debate' : 'default';
const byProvider = adapters();
const whoOf = (providerId: string): Who =>
  (Object.entries(PROVIDER_ID).find(([, id]) => id === providerId)?.[0] as Who | undefined) ?? 'claude';
/** One call at a time per CLI, as the web dialog's default concurrency (D262). */
const gates = new Map(WHO.map((who) => [PROVIDER_ID[who], createSemaphore(1)]));

const caller = createDebateCaller({
  adapterFor: async (providerId) => byProvider[whoOf(providerId)],
  modelsFor: async () => [],
  runGated: async (providerId, fn) => {
    const gate = gates.get(providerId);
    return gate === undefined ? fn() : gate.run(fn);
  },
  router: {
    resolve: (node) => ({
      ok: true,
      route: { providerId: node.providerId ?? PROVIDER_ID.claude, modelId: node.modelId ?? MODEL, viaFallback: false },
    }),
    resolveForBench: () => ({ ok: false, code: 'policy_not_allowed', reason: 'not benched' }),
  },
});
const workspace = createDebateWorkspace();

const routeOf = (who: Who) => ({
  providerId: PROVIDER_ID[who],
  modelId: MODEL,
  routing: { policy: 'fixed' as const, fallbackModelIds: [] },
});
/** Per call: the node default, raised to the CLI floor by the caller (D262). */
const TIMEOUT_MS = 120_000;

function memoryBus(): EventBus & { events: EngineEvent[] } {
  const events: EngineEvent[] = [];
  return {
    events,
    async emit(event) {
      const stored = { ...event, seq: events.length + 1, createdAt: new Date().toISOString() } as EngineEvent;
      events.push(stored);
      return stored;
    },
    async emitTransient() {},
    async subscribe() {
      return () => undefined;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* The arms                                                                    */
/* -------------------------------------------------------------------------- */

interface ArmResult {
  answer?: string;
  correct: boolean;
  tokens: number;
  ms: number;
  error?: string;
}

interface DebateArmResult extends ArmResult {
  openingsMajority?: string;
  openingsCorrect: boolean;
  stoppedBy?: string;
  rounds?: number;
  verdict?: DebateVerdict;
  record?: DebateRecord;
}

const isRight = (answer: string | undefined, expected: string): boolean =>
  answer !== undefined && normaliseAnswer(answer) === normaliseAnswer(expected);

async function singleArm(q: Question): Promise<ArmResult> {
  const started = Date.now();
  const format = { answerFormat: 'choice' as const, options: q.options ?? [] };
  const prompt = openingPrompt({ label: 'A', topic: q.question, material: '', reads: [], instructions: [], format });
  const scratch = await workspace.scratch();
  try {
    const result = await caller.call({
      nodeId: newId(),
      route: routeOf(single),
      prompt,
      turnId: `single/${q.id}/R0-A`,
      workingDir: scratch.dir,
      timeoutMs: TIMEOUT_MS,
      signal: new AbortController().signal,
    });
    const ms = Date.now() - started;
    if (!result.ok) return { correct: false, tokens: 0, ms, error: result.error.message };
    const tokens = result.usage.tokensIn + result.usage.tokensOut;
    const block = lastJsonBlock(result.text);
    const checked = block.ok
      ? validateTurnReply(block.value, { round: 0, label: 'A', format, citable: new Set() })
      : { ok: false as const, errors: [block.error] };
    if (!checked.ok) return { correct: false, tokens, ms, error: `contract: ${checked.errors.join('; ')}` };
    return { answer: checked.value.answer, correct: isRight(checked.value.answer, q.answer), tokens, ms };
  } finally {
    await scratch.dispose();
  }
}

async function debateArm(q: Question): Promise<DebateArmResult> {
  const started = Date.now();
  const bus = memoryBus();
  const node = (who: Who, name: string) => ({
    nodeId: newId(),
    name,
    route: routeOf(who),
    timeoutMs: TIMEOUT_MS,
    maxTokens: 4096,
  });
  const outcome = await runDebate(
    {
      runId: newId(),
      workflowId: newId(),
      debateId: newId(),
      hub: node('claude', 'judge'),
      config: { topic: q.question, answerFormat: 'choice', options: q.options ?? [], maxRounds },
      material: '',
      debaters: WHO.map((who) => ({ ...node(who, who), reads: [] })),
      signal: new AbortController().signal,
    },
    { bus, caller, workspace, tokenBatchMs: 1000 },
  );
  const ms = Date.now() - started;
  if (outcome.kind !== 'verdict') {
    const tokens = outcome.record?.tokens ?? 0;
    const error = outcome.kind === 'failed' ? `${outcome.failureReason}: ${outcome.error.message}` : 'stopped';
    return {
      correct: false,
      openingsCorrect: false,
      tokens,
      ms,
      error,
      ...(outcome.record === undefined ? {} : { record: outcome.record }),
    };
  }
  const { verdict, record } = outcome;
  const majority = verdict.stats.openingsMajority;
  return {
    answer: verdict.answer,
    correct: isRight(verdict.answer, q.answer),
    tokens: verdict.stats.tokens,
    ms,
    ...(majority === undefined ? {} : { openingsMajority: majority }),
    openingsCorrect: majority !== undefined && majority !== 'tie' && isRight(majority, q.answer),
    stoppedBy: verdict.stats.stoppedBy,
    rounds: verdict.stats.rounds,
    verdict,
    record,
  };
}

/* -------------------------------------------------------------------------- */
/* Run and report                                                              */
/* -------------------------------------------------------------------------- */

const pct = (n: number, d: number): string => (d === 0 ? '—' : `${((100 * n) / d).toFixed(1)}%`);
const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

async function main(): Promise<void> {
  const all = loadQuestions(values.questions ?? 'bench/debate/questions.jsonl');
  const limited = values.limit === undefined ? all : all.slice(0, Number(values.limit));
  const scored = limited.filter((q) => (q.options?.length ?? 0) >= 2);
  const skipped = limited.filter((q) => (q.options?.length ?? 0) < 2).map((q) => q.id);
  const startedAt = new Date().toISOString();
  process.stdout.write(
    `Debate eval — ${scored.length} questions, ${skipped.length} free-form skipped, ${values.fake ? 'FAKE (mock-debate)' : 'LIVE CLIs'}, single = ${single}, rounds = ${maxRounds}\n`,
  );

  const rows: { id: string; question: string; options?: string[]; answer: string; sample: boolean; single: ArmResult; debate: DebateArmResult }[] = [];
  for (const [index, q] of scored.entries()) {
    process.stdout.write(`[${index + 1}/${scored.length}] ${q.id} … `);
    const singleResult = await singleArm(q).catch((error: unknown) => ({
      correct: false,
      tokens: 0,
      ms: 0,
      error: error instanceof Error ? error.message : String(error),
    }));
    const debateResult = await debateArm(q).catch((error: unknown) => ({
      correct: false,
      openingsCorrect: false,
      tokens: 0,
      ms: 0,
      error: error instanceof Error ? error.message : String(error),
    }));
    rows.push({
      id: q.id,
      question: q.question,
      ...(q.options === undefined ? {} : { options: q.options }),
      answer: q.answer,
      sample: q.sample === true,
      single: singleResult,
      debate: debateResult,
    });
    process.stdout.write(
      `single ${singleResult.correct ? 'right' : 'wrong'}${singleResult.error ? ' (error)' : ''}, debate ${debateResult.correct ? 'right' : 'wrong'}${debateResult.error ? ' (error)' : ''}\n`,
    );
  }

  const n = rows.length;
  const arms = [
    {
      arm: 'SINGLE',
      right: rows.filter((r) => r.single.correct).length,
      tokens: mean(rows.map((r) => r.single.tokens)),
      ms: mean(rows.map((r) => r.single.ms)),
      errors: rows.filter((r) => r.single.error !== undefined).length,
    },
    {
      arm: 'OPENINGS VOTE',
      right: rows.filter((r) => r.debate.openingsCorrect).length,
      // Free: the openings are part of the debate's own calls.
      tokens: Number.NaN,
      ms: Number.NaN,
      errors: rows.filter((r) => r.debate.openingsMajority === undefined).length,
    },
    {
      arm: 'DEBATE',
      right: rows.filter((r) => r.debate.correct).length,
      tokens: mean(rows.map((r) => r.debate.tokens)),
      ms: mean(rows.map((r) => r.debate.ms)),
      errors: rows.filter((r) => r.debate.error !== undefined).length,
    },
  ];
  const fixed = rows.filter((r) => !r.debate.openingsCorrect && r.debate.correct).map((r) => r.id);
  const broke = rows.filter((r) => r.debate.openingsCorrect && !r.debate.correct).map((r) => r.id);
  const wins = rows.filter((r) => r.debate.correct && !r.single.correct).map((r) => r.id);
  const losses = rows.filter((r) => !r.debate.correct && r.single.correct).map((r) => r.id);
  const ties = rows.filter((r) => r.debate.correct === r.single.correct).map((r) => r.id);

  const table = [
    '',
    `| Arm | Accuracy | Mean tokens | Mean wall time | Errors |`,
    `|---|---|---|---|---|`,
    ...arms.map(
      (a) =>
        `| ${a.arm} | ${a.right}/${n} (${pct(a.right, n)}) | ${Number.isNaN(a.tokens) ? 'free (inside DEBATE)' : Math.round(a.tokens)} | ${Number.isNaN(a.ms) ? '—' : `${(a.ms / 1000).toFixed(1)} s`} | ${a.errors} |`,
    ),
    '',
    `Fixed (openings majority wrong, verdict right): ${fixed.length} ${fixed.length === 0 ? '' : `— ${fixed.join(', ')}`}`,
    `Broke (openings majority right, verdict wrong): ${broke.length} ${broke.length === 0 ? '' : `— ${broke.join(', ')}`}`,
    `Debate vs single: ${wins.length} wins / ${losses.length} losses / ${ties.length} ties`,
    `Free-form skipped: ${skipped.length}${skipped.length === 0 ? '' : ` — ${skipped.join(', ')}`}`,
    ...(rows.some((r) => r.sample) ? ['', 'Includes SAMPLE questions: a smoke run, not evidence.'] : []),
    '',
  ].join('\n');
  process.stdout.write(table);

  mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(':', '-').replace(/\.\d+Z$/, 'Z');
  const file = join(OUT_DIR, `results-${stamp}.json`);
  writeFileSync(
    file,
    `${JSON.stringify(
      {
        startedAt,
        finishedAt: new Date().toISOString(),
        settings: {
          live: !values.fake,
          single,
          debaters: WHO,
          judge: 'claude',
          maxRounds,
          model: MODEL,
          questions: values.questions,
        },
        summary: { scored: n, skipped, arms, fixed, broke, debateVsSingle: { wins, losses, ties } },
        rows,
      },
      null,
      2,
    )}\n`,
  );
  process.stdout.write(`Full results: ${file}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
