import {
  DEBATE_LIMITS,
  DEBATE_TRUNCATED_MARKER,
  type DebateAnswerFormat,
  type DebateLabel,
  type DebateTurn,
} from '@ace/contracts';

import type { DebateReadContent } from './ports.js';

/**
 * The engine-owned prompt templates (the brief's PROMPT TEMPLATES, D343–D346). Every turn's prompt
 * is rebuilt from the debate record (DB4); nothing here ever names a node, a provider or a model
 * (DB6). A rebuttal restates the debater's label, which the brief's rebuttal template leaves to
 * "as above": a stateless call cannot know which of the listed turns is its own otherwise.
 */

export interface AnswerFormat {
  answerFormat: DebateAnswerFormat;
  options?: readonly string[];
}

interface Context {
  topic: string;
  material: string;
  instructions: readonly string[];
  format: AnswerFormat;
}

interface DebaterContext extends Context {
  label: DebateLabel;
  stance?: string;
  reads: readonly DebateReadContent[];
}

export type OpeningPromptInput = DebaterContext;

export interface LastRoundEntry {
  turnId: string;
  mine: boolean;
  /** Absent when that debater has no valid turn in the round (it sat out or was cut). */
  turn?: DebateTurn;
}

export interface RebuttalPromptInput extends DebaterContext {
  round: number;
  maxRounds: number;
  lastRound: readonly LastRoundEntry[];
}

export interface JudgePromptInput extends Context {
  final: readonly DebateTurn[];
  earlier: readonly DebateTurn[];
}

const OPENING_JSON = '{"answer": "...", "confidence": 0.0, "reasoning": "..."}';
const REBUTTAL_JSON =
  '{"answer": "...", "confidence": 0.0, "reasoning": "...", "rebuttals": [{"targetTurnId": "...", "claim": "...", "response": "..."}], "positionChanged": false, "changedBecause": null}';
const JUDGE_JSON =
  '{"answer": "...", "confidence": 0.0, "rationale": [{"point": "...", "supportedBy": ["R2-A"]}], "dissent": [{"label": "B", "answer": "...", "strongestArgument": "...", "turnId": "R2-B"}], "openQuestions": []}';

/** D343: reasoning shown to anyone but its author, cut at 6000 characters with a marker. */
export function shownReasoning(reasoning: string): string {
  return reasoning.length > DEBATE_LIMITS.shownReasoningMax
    ? `${reasoning.slice(0, DEBATE_LIMITS.shownReasoningMax)} ${DEBATE_TRUNCATED_MARKER}`
    : reasoning;
}

function answerLine(format: AnswerFormat): string {
  return format.answerFormat === 'choice'
    ? `Answer: exactly one of: ${(format.options ?? []).map((option) => `"${option}"`).join(', ')}`
    : 'Answer: a direct answer to the question';
}

function instructionLines(instructions: readonly string[]): string[] {
  return instructions.length === 0
    ? []
    : [`INSTRUCTIONS FROM THE HUMAN TO YOU: ${instructions.join('\n')}`];
}

function questionAndMaterial(context: Context, reads: readonly DebateReadContent[]): string[] {
  const material = context.material.trim();
  const body = material !== '' ? [material] : reads.length === 0 ? ['(none)'] : [];
  return [
    'QUESTION:',
    context.topic,
    'MATERIAL:',
    ...body,
    ...reads.flatMap((read) => [`--- ${read.path} ---`, read.content]),
  ];
}

function stanceLines(stance: string | undefined): string[] {
  return stance === undefined
    ? []
    : [`Your assigned stance: ${stance}. Argue it honestly. If the evidence defeats it, say so.`];
}

const turnLine = (turn: DebateTurn): string =>
  `${turn.answer} | ${turn.confidence} | ${shownReasoning(turn.reasoning)}`;

export function openingPrompt(input: OpeningPromptInput): string {
  return [
    `You are debater ${input.label} in a structured debate. Other debaters are answering the same question on their own. You will see their answers next round.`,
    ...stanceLines(input.stance),
    ...questionAndMaterial(input, input.reads),
    ...instructionLines(input.instructions),
    answerLine(input.format),
    'End with one fenced json block:',
    OPENING_JSON,
  ].join('\n');
}

export function rebuttalPrompt(input: RebuttalPromptInput): string {
  return [
    `You are debater ${input.label} in a structured debate.`,
    `Round ${input.round} of ${input.maxRounds}. Below are last round's turns: yours and the other debaters'.`,
    'Rules:',
    '- Test or attack at least one specific claim from another debater. Cite its turn id.',
    '- Change your answer only if a specific argument beats yours. If you change, give that turn id and the argument.',
    '- "Most debaters agree" is not a reason to change.',
    '- If nothing beat your answer, defend it against the strongest objection.',
    '- Confidence must reflect the evidence, not the room.',
    ...stanceLines(input.stance),
    ...questionAndMaterial(input, input.reads),
    ...instructionLines(input.instructions),
    'LAST ROUND:',
    ...input.lastRound.map((entry) => {
      const id = `[${entry.turnId}]${entry.mine ? ' (you)' : ''}`;
      return entry.turn === undefined
        ? `${id} (no valid turn this round)`
        : `${id} ${turnLine(entry.turn)}`;
    }),
    answerLine(input.format),
    'End with one fenced json block:',
    REBUTTAL_JSON,
  ].join('\n');
}

function fullTurn(turn: DebateTurn): string[] {
  return [
    `[${turn.turnId}] ${turnLine(turn)}`,
    ...turn.rebuttals.map(
      (rebuttal) => `  rebuts ${rebuttal.targetTurnId}: "${rebuttal.claim}" → ${rebuttal.response}`,
    ),
    ...(turn.changedBecause === null
      ? []
      : [`  changed because of ${turn.changedBecause.turnId}: ${turn.changedBecause.argument}`]),
  ];
}

function compactTurn(turn: DebateTurn): string {
  const changed =
    turn.changedBecause === null
      ? `changed: ${turn.positionChanged ? 'yes' : 'no'}`
      : `changed: yes, because of ${turn.changedBecause.turnId}: ${turn.changedBecause.argument}`;
  const rebuttals =
    turn.rebuttals.length === 0
      ? 'rebuttals: none'
      : `rebuttals: ${turn.rebuttals.map((r) => `${r.targetTurnId} "${r.claim}"`).join('; ')}`;
  return `[${turn.turnId}] ${turn.answer} | ${turn.confidence} | ${changed} | ${rebuttals}`;
}

export function judgePrompt(input: JudgePromptInput): string {
  return [
    'You are the judge of a debate. Pick the best answer from the arguments, not from how many debaters hold it. A minority answer with the better argument wins.',
    'Every point in your rationale must cite the turn ids it relies on. If you add a point no debater made, cite "judge".',
    'List every unresolved disagreement in dissent, with its strongest argument.',
    ...questionAndMaterial(input, []),
    ...instructionLines(input.instructions),
    answerLine(input.format),
    'FINAL ROUND (full):',
    ...(input.final.length === 0 ? ['(no turns)'] : input.final.flatMap(fullTurn)),
    ...(input.earlier.length === 0
      ? []
      : ['EARLIER ROUNDS (compact):', ...input.earlier.map(compactTurn)]),
    'End with one fenced json block:',
    JUDGE_JSON,
  ].join('\n');
}

/** D358: a repair is stateless too, so the model is shown the reply it is asked to correct. */
export function repairPrompt(original: string, reply: string, errors: readonly string[]): string {
  return `${original}\n\nYOUR LAST REPLY:\n${reply}\n\nYour last reply didn't meet the required format: ${errors.join('; ')}. Reply again with only the corrected fenced json block.`;
}
