/** One valid frame per debate event type (D352), for the run-event list tests. */

const RUN = '01JA0000000000000000000001';
const DEBATE = '01JB0000000000000000000001';
const HUB = '01JC0000000000000000000001';
const NODE_A = '01JD000000000000000000000A';
const NODE_B = '01JD000000000000000000000B';
const MSG = '01JE0000000000000000000001';

const base = { runId: RUN, debateId: DEBATE };
const usage = { tokensIn: 10, tokensOut: 4, costUsd: 0 };

export const DEBATE_FRAMES: Record<string, { type: string; payload: unknown; seq?: number }> = {
  'debate.started': {
    type: 'debate.started',
    payload: {
      ...base,
      hubNodeId: HUB,
      config: {
        topic: 'Which cache?',
        answerFormat: 'free',
        maxRounds: 2,
        earlyStop: true,
        baselineJudge: true,
      },
      debaters: [
        { label: 'A', nodeId: NODE_A },
        { label: 'B', nodeId: NODE_B, stance: 'against' },
      ],
      readsSnapshot: { sha: null, dirty: false, files: [] },
    },
    seq: 201,
  },
  'debate.round_started': {
    type: 'debate.round_started',
    payload: { ...base, round: 0, labels: ['A', 'B'] },
    seq: 202,
  },
  'debate.turn_started': {
    type: 'debate.turn_started',
    payload: { ...base, callId: 'R0-A', nodeId: NODE_A, attempt: 1, kind: 'turn' },
    seq: 203,
  },
  'debate.turn_delta': {
    type: 'debate.turn_delta',
    payload: { ...base, callId: 'R0-A', text: 'Redis, because' },
  },
  'debate.turn_completed': {
    type: 'debate.turn_completed',
    payload: {
      ...base,
      nodeId: NODE_A,
      turn: {
        turnId: 'R0-A',
        round: 0,
        label: 'A',
        answer: 'Redis',
        confidence: 0.6,
        reasoning: 'Shared across instances.',
        rebuttals: [],
        positionChanged: false,
        changedBecause: null,
      },
      usage,
      durationMs: 1200,
    },
    seq: 204,
  },
  'debate.turn_failed': {
    type: 'debate.turn_failed',
    payload: {
      ...base,
      callId: 'R0-B',
      nodeId: NODE_B,
      reason: 'The CLI exited with code 1.',
      failureReason: 'RUN_FAILED',
      willRetry: true,
      out: false,
      usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
    },
    seq: 205,
  },
  'debate.turn_violation': {
    type: 'debate.turn_violation',
    payload: {
      ...base,
      callId: 'R0-B',
      nodeId: NODE_B,
      errors: ['no fenced json block'],
      willRepair: true,
      usage,
    },
    seq: 206,
  },
  'debate.instruction_delivered': {
    type: 'debate.instruction_delivered',
    payload: { ...base, nodeId: NODE_A, callId: 'R1-A', messageId: MSG, text: 'Mind the cost.' },
    seq: 207,
  },
  'debate.round_completed': {
    type: 'debate.round_completed',
    payload: { ...base, round: 0, changedCount: 0 },
    seq: 208,
  },
  'debate.control': {
    type: 'debate.control',
    payload: { ...base, action: 'judge_now' },
    seq: 209,
  },
  'debate.stopped': {
    type: 'debate.stopped',
    payload: { ...base, stoppedBy: 'human_end' },
    seq: 210,
  },
  'debate.verdict': {
    type: 'debate.verdict',
    payload: {
      ...base,
      verdict: {
        answer: 'Redis',
        confidence: 0.7,
        rationale: [{ point: 'Shared state wins.', supportedBy: ['R0-A'] }],
        dissent: [],
        openQuestions: [],
        stats: {
          debateId: DEBATE,
          rounds: 0,
          stoppedBy: 'human_end',
          turns: 1,
          violations: 0,
          tokens: 28,
        },
      },
      usage,
    },
    seq: 211,
  },
  'debate.failed': {
    type: 'debate.failed',
    payload: { ...base, failureReason: 'RUN_FAILED', message: 'Only one debater is left.' },
    seq: 212,
  },
};
