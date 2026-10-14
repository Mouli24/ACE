import { describe, expect, it } from 'vitest';

import {
  DEBATE_EVENT_TYPES,
  DEBATE_LIMITS,
  DebateHubConfigSchema,
  DebateStartedPayloadSchema,
  DebateTurnCompletedPayloadSchema,
  DebaterConfigSchema,
  DebateVerdictSchema,
  createDebateFold,
  foldDebate,
  foldDebates,
  isDebateTurnId,
  parseDebateTurnId,
  turnIdFor,
  type DebateFoldEvent,
} from '../debate.js';
import {
  PERSISTED_RUN_EVENT_TYPES,
  RUN_EVENT_TYPES,
  RunEventSchema,
  TRANSIENT_EVENT_TYPES,
} from '../events.js';
import { TRACE_ENTRY_KIND_BY_EVENT_TYPE } from '../usage.js';

const RUN = '01JA0000000000000000000001';
const DEBATE = '01JB0000000000000000000001';
const HUB = '01JC0000000000000000000001';
const NODE_A = '01JD000000000000000000000A';
const NODE_B = '01JD000000000000000000000B';
const NODE_C = '01JD000000000000000000000C';
const MSG = '01JE0000000000000000000001';
const DEBATE_2 = '01JB0000000000000000000002';

const usage = (tokensIn: number, tokensOut: number) => ({ tokensIn, tokensOut, costUsd: 0 });

/** One short, complete debate: three debaters, one rebuttal round, B is out, a verdict. */
function sampleLog(): DebateFoldEvent[] {
  let seq = 100;
  const at = (type: string, payload: Record<string, unknown>): DebateFoldEvent => ({
    type,
    seq: (seq += 1),
    payload: { runId: RUN, debateId: DEBATE, ...payload },
  });
  const turn = (
    round: number,
    label: string,
    answer: string,
    extra: Record<string, unknown> = {},
  ) => ({
    turnId: `R${round}-${label}`,
    round,
    label,
    answer,
    confidence: 0.7,
    reasoning: `${label} reasons`,
    rebuttals: [],
    positionChanged: false,
    changedBecause: null,
    ...extra,
  });
  return [
    at('debate.started', {
      hubNodeId: HUB,
      config: {
        topic: 'Pick one',
        answerFormat: 'choice',
        options: ['yes', 'no'],
        maxRounds: 1,
        earlyStop: true,
        baselineJudge: true,
      },
      debaters: [
        { label: 'A', nodeId: NODE_A, stance: 'yes' },
        { label: 'B', nodeId: NODE_B },
        { label: 'C', nodeId: NODE_C },
      ],
      readsSnapshot: {
        sha: 'abc123',
        dirty: false,
        files: [{ label: 'A', path: 'README.md', chars: 12 }],
      },
    }),
    at('debate.round_started', { round: 0, labels: ['A', 'B', 'C'] }),
    at('debate.turn_started', { callId: 'R0-A', nodeId: NODE_A, attempt: 1, kind: 'turn' }),
    at('debate.turn_started', { callId: 'R0-B', nodeId: NODE_B, attempt: 1, kind: 'turn' }),
    at('debate.turn_started', { callId: 'R0-C', nodeId: NODE_C, attempt: 1, kind: 'turn' }),
    at('debate.turn_completed', {
      nodeId: NODE_A,
      turn: turn(0, 'A', 'yes'),
      usage: usage(10, 5),
      durationMs: 3,
    }),
    at('debate.turn_failed', {
      callId: 'R0-B',
      nodeId: NODE_B,
      reason: 'cli_exit_1',
      failureReason: 'RUN_FAILED',
      willRetry: true,
      out: false,
      usage: usage(0, 0),
    }),
    at('debate.turn_started', { callId: 'R0-B', nodeId: NODE_B, attempt: 2, kind: 'retry' }),
    at('debate.turn_failed', {
      callId: 'R0-B',
      nodeId: NODE_B,
      reason: 'cli_exit_1',
      failureReason: 'RUN_FAILED',
      willRetry: false,
      out: true,
      usage: usage(1, 0),
    }),
    at('debate.turn_completed', {
      nodeId: NODE_C,
      turn: turn(0, 'C', 'no'),
      usage: usage(10, 6),
      durationMs: 4,
    }),
    at('debate.round_completed', { round: 0, changedCount: 0 }),
    at('debate.round_started', { round: 1, labels: ['A', 'C'] }),
    at('debate.instruction_delivered', {
      nodeId: NODE_A,
      callId: 'R1-A',
      messageId: MSG,
      text: 'Press on cost',
    }),
    at('debate.turn_started', { callId: 'R1-A', nodeId: NODE_A, attempt: 1, kind: 'turn' }),
    at('debate.turn_started', { callId: 'R1-C', nodeId: NODE_C, attempt: 1, kind: 'turn' }),
    at('debate.turn_violation', {
      callId: 'R1-C',
      nodeId: NODE_C,
      errors: ['rebuttals: at least one is required'],
      willRepair: true,
      usage: usage(3, 3),
    }),
    at('debate.turn_started', { callId: 'R1-C', nodeId: NODE_C, attempt: 2, kind: 'repair' }),
    at('debate.turn_completed', {
      nodeId: NODE_C,
      turn: turn(1, 'C', 'yes', {
        rebuttals: [{ targetTurnId: 'R0-A', claim: 'cheap', response: 'agreed' }],
        positionChanged: true,
        changedBecause: { turnId: 'R0-A', argument: 'cost' },
      }),
      usage: usage(12, 8),
      durationMs: 5,
    }),
    at('debate.turn_completed', {
      nodeId: NODE_A,
      turn: turn(1, 'A', 'yes', {
        rebuttals: [{ targetTurnId: 'R0-C', claim: 'slow', response: 'no' }],
      }),
      usage: usage(11, 7),
      durationMs: 5,
    }),
    at('debate.round_completed', { round: 1, changedCount: 1 }),
    at('debate.stopped', { stoppedBy: 'max_rounds' }),
    at('debate.verdict', {
      verdict: {
        answer: 'yes',
        confidence: 0.8,
        rationale: [{ point: 'cost wins', supportedBy: ['R1-C', 'judge'] }],
        dissent: [],
        openQuestions: [],
        stats: {
          debateId: DEBATE,
          rounds: 1,
          stoppedBy: 'max_rounds',
          turns: 4,
          violations: 0,
          tokens: 119,
          openingsMajority: 'tie',
        },
      },
      usage: usage(20, 10),
    }),
  ];
}

describe('D357 DebateHubConfig', () => {
  it('fills the defaults the brief names: 2 rounds, early stop on, baseline judge on, free answers', () => {
    expect(DebateHubConfigSchema.parse({ topic: 'Which cache?' })).toEqual({
      topic: 'Which cache?',
      answerFormat: 'free',
      maxRounds: 2,
      earlyStop: true,
      baselineJudge: true,
    });
  });

  it('allows 1–4 rounds and nothing else (DB3)', () => {
    for (const maxRounds of [1, 4]) {
      expect(DebateHubConfigSchema.safeParse({ topic: 't', maxRounds }).success).toBe(true);
    }
    for (const maxRounds of [0, 5, 2.5]) {
      expect(DebateHubConfigSchema.safeParse({ topic: 't', maxRounds }).success).toBe(false);
    }
  });

  it('requires 2–8 distinct options in choice mode', () => {
    const choice = (options?: string[]) =>
      DebateHubConfigSchema.safeParse({ topic: 't', answerFormat: 'choice', options }).success;
    expect(choice(undefined)).toBe(false);
    expect(choice(['only'])).toBe(false);
    expect(choice(['a', 'b'])).toBe(true);
    expect(choice(['1', '2', '3', '4', '5', '6', '7', '8'])).toBe(true);
    expect(choice(['1', '2', '3', '4', '5', '6', '7', '8', '9'])).toBe(false);
    expect(choice(['Yes', ' yes '])).toBe(false);
  });

  it('refuses an empty topic and an unknown key', () => {
    expect(DebateHubConfigSchema.safeParse({ topic: '   ' }).success).toBe(false);
    expect(DebateHubConfigSchema.safeParse({ topic: 't', judges: 3 }).success).toBe(false);
  });
});

describe('D357 DebaterConfig', () => {
  it('takes an optional stance and optional workspace reads', () => {
    expect(DebaterConfigSchema.parse({})).toEqual({});
    expect(DebaterConfigSchema.parse({ stance: 'for', reads: ['src/a.ts'] })).toEqual({
      stance: 'for',
      reads: ['src/a.ts'],
    });
    expect(DebaterConfigSchema.safeParse({ reads: [''] }).success).toBe(false);
  });
});

describe('D345 turn ids are R{round}-{label}, assigned by the engine', () => {
  it('builds and parses them', () => {
    expect(turnIdFor(0, 'A')).toBe('R0-A');
    expect(turnIdFor(2, 'C')).toBe('R2-C');
    expect(parseDebateTurnId('R3-E')).toEqual({ round: 3, label: 'E' });
    expect(parseDebateTurnId('R5-A')).toBeUndefined();
    expect(parseDebateTurnId('R1-F')).toBeUndefined();
    expect(isDebateTurnId('R1-B')).toBe(true);
    expect(isDebateTurnId('judge')).toBe(false);
  });

  it('pins the limits of DB2, DB3, DB4 and DB8', () => {
    expect(DEBATE_LIMITS).toEqual({
      minDebaters: 2,
      maxDebaters: 5,
      minRounds: 1,
      maxRounds: 4,
      defaultRounds: 2,
      minOptions: 2,
      maxOptions: 8,
      shownReasoningMax: 6000,
      readsMaxChars: 100_000,
    });
  });
});

describe('D346 DebateVerdict', () => {
  it('requires a cited rationale and engine stats, and keeps dissent', () => {
    const verdict = sampleLog().at(-1)?.payload as { verdict: unknown };
    expect(DebateVerdictSchema.safeParse(verdict.verdict).success).toBe(true);
    const bare = {
      ...(verdict.verdict as Record<string, unknown>),
      rationale: [{ point: 'x', supportedBy: [] }],
    };
    expect(DebateVerdictSchema.safeParse(bare).success).toBe(false);
  });
});

describe('D352 debate events are run events in the log', () => {
  it('lists every debate type, with the delta transient and the rest persisted', () => {
    expect([...DEBATE_EVENT_TYPES]).toEqual([
      'debate.started',
      'debate.round_started',
      'debate.turn_started',
      'debate.turn_delta',
      'debate.turn_completed',
      'debate.turn_failed',
      'debate.turn_violation',
      'debate.instruction_delivered',
      'debate.round_completed',
      'debate.control',
      'debate.stopped',
      'debate.verdict',
      'debate.failed',
    ]);
    for (const type of DEBATE_EVENT_TYPES) expect(RUN_EVENT_TYPES).toContain(type);
    expect(TRANSIENT_EVENT_TYPES).toContain('debate.turn_delta');
    for (const type of DEBATE_EVENT_TYPES.filter((t) => t !== 'debate.turn_delta')) {
      expect(PERSISTED_RUN_EVENT_TYPES).toContain(type);
      expect(
        TRACE_ENTRY_KIND_BY_EVENT_TYPE[type as keyof typeof TRACE_ENTRY_KIND_BY_EVENT_TYPE],
      ).toBeDefined();
    }
  });

  it('parses every frame of the sample log as a run event', () => {
    for (const event of sampleLog()) {
      expect(RunEventSchema.safeParse(event).success, event.type).toBe(true);
    }
    expect(
      RunEventSchema.safeParse({
        type: 'debate.turn_delta',
        payload: { runId: RUN, debateId: DEBATE, callId: 'R0-A', text: 'Hal' },
      }).success,
    ).toBe(true);
  });

  it('carries none of the keys the log refuses (D-082)', () => {
    expect(JSON.stringify(sampleLog())).not.toMatch(
      /"(bytes|base64|data|dataUrl|buffer|blob)"\s*:/,
    );
  });

  it('refuses an unknown key on a payload', () => {
    const started = sampleLog()[0]?.payload as Record<string, unknown>;
    expect(DebateStartedPayloadSchema.safeParse({ ...started, extra: 1 }).success).toBe(false);
    const completed = sampleLog()[5]?.payload as Record<string, unknown>;
    expect(DebateTurnCompletedPayloadSchema.safeParse(completed).success).toBe(true);
  });
});

describe('D352 foldDebate is a pure fold over the debate events', () => {
  it('rebuilds the debate: debaters, rounds, turns, failures, violations, instructions, verdict', () => {
    const record = foldDebate(sampleLog());
    expect(record).toBeDefined();
    if (record === undefined) return;
    expect(record.debateId).toBe(DEBATE);
    expect(record.status).toBe('done');
    expect(record.stoppedBy).toBe('max_rounds');
    expect(record.debaters.map((d) => [d.label, d.status])).toEqual([
      ['A', 'active'],
      ['B', 'out'],
      ['C', 'active'],
    ]);
    expect(record.debaters[0]?.reads).toEqual([{ path: 'README.md', chars: 12 }]);
    expect(record.rounds.map((r) => [r.round, r.completed, r.changedCount])).toEqual([
      [0, true, 0],
      [1, true, 1],
    ]);
    expect(record.rounds[0]?.turns.map((t) => t.turnId)).toEqual(['R0-A', 'R0-C']);
    expect(record.rounds[0]?.failures.map((f) => [f.callId, f.out])).toEqual([
      ['R0-B', false],
      ['R0-B', true],
    ]);
    expect(record.rounds[1]?.violations).toEqual([
      {
        callId: 'R1-C',
        nodeId: NODE_C,
        errors: ['rebuttals: at least one is required'],
        willRepair: true,
      },
    ]);
    expect(record.instructions).toEqual([
      { nodeId: NODE_A, callId: 'R1-A', messageId: MSG, text: 'Press on cost' },
    ]);
    expect(record.turns['R1-C']?.changedBecause).toEqual({ turnId: 'R0-A', argument: 'cost' });
    expect(record.inFlight).toEqual([]);
    expect(record.verdict?.answer).toBe('yes');
  });

  it('adds up every call it was told about, failed and repaired ones included', () => {
    // 15 + 0 + 1 + 16 + 6 + 20 + 18 + 30 = 106
    expect(foldDebate(sampleLog())?.tokens).toBe(106);
    expect(foldDebate(sampleLog())?.debaters.map((d) => d.tokens)).toEqual([33, 1, 42]);
  });

  it('shows calls in flight until they end', () => {
    const log = sampleLog().slice(0, 5);
    expect(foldDebate(log)?.inFlight.map((c) => c.callId)).toEqual(['R0-A', 'R0-B', 'R0-C']);
    expect(foldDebate(log)?.status).toBe('running');
  });

  it('ignores a seq it has already applied, so a replay over a live fold changes nothing', () => {
    const log = sampleLog();
    const fold = createDebateFold();
    for (const event of log) fold.apply(event);
    const once = structuredClone(fold.records());
    for (const event of log) expect(fold.apply(event)).toBe(false);
    expect(fold.records()).toEqual(once);
  });

  it('ignores events of other types and transient deltas', () => {
    const log = [
      ...sampleLog().slice(0, 3),
      { type: 'node.state', seq: 999, payload: { runId: RUN } },
      {
        type: 'debate.turn_delta',
        payload: { runId: RUN, debateId: DEBATE, callId: 'R0-A', text: 'x' },
      },
    ];
    expect(foldDebate(log)?.inFlight.map((c) => c.callId)).toEqual(['R0-A']);
  });

  it('keeps each debate of a log apart, in the order they started (a re-run hub, D340)', () => {
    const first = sampleLog();
    const second = sampleLog().map((event) => ({
      ...event,
      seq: (event.seq ?? 0) + 1000,
      payload: { ...(event.payload as object), debateId: DEBATE_2 },
    }));
    const records = foldDebates([...first, ...second]);
    expect(records.map((r) => r.debateId)).toEqual([DEBATE, DEBATE_2]);
    expect(foldDebate([...first, ...second], DEBATE)?.debateId).toBe(DEBATE);
    expect(foldDebate([...first, ...second])?.debateId).toBe(DEBATE_2);
  });

  it('records a pause until it is resumed, and a failure', () => {
    const log = sampleLog().slice(0, 11);
    const paused = [
      ...log,
      {
        type: 'debate.control',
        seq: 500,
        payload: { runId: RUN, debateId: DEBATE, action: 'pause_after_round' },
      },
    ];
    expect(foldDebate(paused)?.pauseRequested).toBe(true);
    const resumed = [
      ...paused,
      {
        type: 'debate.control',
        seq: 501,
        payload: { runId: RUN, debateId: DEBATE, action: 'resume' },
      },
    ];
    expect(foldDebate(resumed)?.pauseRequested).toBe(false);
    const failed = [
      ...resumed,
      {
        type: 'debate.stopped',
        seq: 502,
        payload: { runId: RUN, debateId: DEBATE, stoppedBy: 'failures' },
      },
      {
        type: 'debate.failed',
        seq: 503,
        payload: {
          runId: RUN,
          debateId: DEBATE,
          failureReason: 'RUN_FAILED',
          message: 'Only one debater is left.',
        },
      },
    ];
    expect(foldDebate(failed)?.status).toBe('failed');
    expect(foldDebate(failed)?.failure).toEqual({
      failureReason: 'RUN_FAILED',
      message: 'Only one debater is left.',
    });
    expect(foldDebate(failed)?.controls.map((c) => c.action)).toEqual([
      'pause_after_round',
      'resume',
    ]);
  });

  it('records a killed call as cancelled, and its debater stays in the debate (D349)', () => {
    const log = [
      ...sampleLog().slice(0, 5),
      {
        type: 'debate.turn_failed',
        seq: 700,
        payload: {
          runId: RUN,
          debateId: DEBATE,
          callId: 'R0-C',
          nodeId: NODE_C,
          reason: 'Stopped by Judge now.',
          cancelled: true,
          willRetry: false,
          out: false,
          usage: usage(4, 2),
        },
      },
    ];
    const record = foldDebate(log);
    expect(record?.rounds[0]?.failures).toEqual([
      {
        callId: 'R0-C',
        nodeId: NODE_C,
        reason: 'Stopped by Judge now.',
        cancelled: true,
        willRetry: false,
        out: false,
      },
    ]);
    expect(record?.debaters.find((d) => d.label === 'C')?.status).toBe('active');
    expect(record?.inFlight.map((c) => c.callId)).toEqual(['R0-A', 'R0-B']);
  });

  it('skips a payload that does not parse rather than throwing', () => {
    const log = [
      ...sampleLog().slice(0, 2),
      { type: 'debate.turn_started', seq: 900, payload: { nope: 1 } },
    ];
    expect(foldDebate(log)?.inFlight).toEqual([]);
  });

  it('answers undefined for a log without a debate', () => {
    expect(foldDebate([])).toBeUndefined();
  });
});
