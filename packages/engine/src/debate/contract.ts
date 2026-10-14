import {
  normaliseAnswer,
  parseDebateTurnId,
  type DebateChangedBecause,
  type DebateDissent,
  type DebateLabel,
  type DebateRationalePoint,
  type DebateRebuttal,
  type DebateTurn,
  type DebateVerdict,
} from '@ace/contracts';

import type { AnswerFormat } from './prompts.js';

/**
 * The turn and verdict contracts (D344, D346, D348). A reply's JSON is the last fenced ```json
 * block of the CLI's output; a missing or broken block, or one that breaks a rule here, is a
 * contract violation and goes to the one repair (D350). Every error is worded for the repair
 * prompt, and none quotes more of the reply than a turn id.
 */

export type JsonBlock = { ok: true; value: unknown } | { ok: false; error: string };

const FENCE = /```json[^\S\r\n]*\r?\n?([\s\S]*?)```/gi;

export function lastJsonBlock(text: string): JsonBlock {
  const blocks = [...text.matchAll(FENCE)];
  const last = blocks.at(-1)?.[1];
  if (last === undefined) return { ok: false, error: 'no fenced json block was found' };
  try {
    return { ok: true, value: JSON.parse(last) as unknown };
  } catch (error) {
    return {
      ok: false,
      error: `the json block does not parse: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export type Checked<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '';

/** A choice answer as its canonical option, or why it is not one (DB9: trimmed, any case). */
function checkAnswer(raw: unknown, format: AnswerFormat): Checked<string> {
  if (!isText(raw)) return { ok: false, errors: ['answer: must be a non-empty string'] };
  if (format.answerFormat !== 'choice') return { ok: true, value: raw.trim() };
  const option = (format.options ?? []).find((o) => normaliseAnswer(o) === normaliseAnswer(raw));
  return option === undefined
    ? {
        ok: false,
        errors: [
          `answer: must be exactly one of ${(format.options ?? []).map((o) => `"${o}"`).join(', ')}`,
        ],
      }
    : { ok: true, value: option };
}

function checkConfidence(raw: unknown): string | undefined {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 && raw <= 1
    ? undefined
    : 'confidence: must be a number from 0 to 1';
}

export interface TurnContext {
  round: number;
  label: DebateLabel;
  format: AnswerFormat;
  /** The other debaters' valid turns of the previous round: the only turns a rebuttal may cite. */
  citable: ReadonlySet<string>;
  /** This debater's latest valid turn, for the engine's positionChanged in choice mode. */
  ownPrevious?: DebateTurn;
}

/** Why a cited turn id is not one this turn may cite, or undefined when it is. */
function citationError(field: string, raw: unknown, context: TurnContext): string | undefined {
  if (typeof raw !== 'string') return `${field}: must be a turn id`;
  const parsed = parseDebateTurnId(raw);
  if (parsed === undefined) return `${field}: "${raw}" is not a turn id`;
  if (parsed.label === context.label) return `${field}: ${raw} is your own turn`;
  if (parsed.round !== context.round - 1) {
    return `${field}: ${raw} is not from round ${context.round - 1}`;
  }
  if (!context.citable.has(raw)) return `${field}: ${raw} does not exist`;
  return undefined;
}

export function validateTurnReply(value: unknown, context: TurnContext): Checked<DebateTurn> {
  if (!isRecord(value)) return { ok: false, errors: ['the json block must be an object'] };
  const errors: string[] = [];

  const answer = checkAnswer(value.answer, context.format);
  if (!answer.ok) errors.push(...answer.errors);
  const confidenceError = checkConfidence(value.confidence);
  if (confidenceError !== undefined) errors.push(confidenceError);
  if (typeof value.reasoning !== 'string') errors.push('reasoning: must be a string');

  const turnId = `R${context.round}-${context.label}`;
  const rebuttals: DebateRebuttal[] = [];
  let positionChanged = false;
  let changedBecause: DebateChangedBecause | null = null;

  if (context.round > 0) {
    if (!Array.isArray(value.rebuttals)) {
      errors.push('rebuttals: must be a list');
    } else {
      if (value.rebuttals.length === 0 && context.citable.size > 0) {
        errors.push(
          'rebuttals: at least one is required, citing another debater’s last-round turn',
        );
      }
      value.rebuttals.forEach((raw: unknown, index) => {
        const field = `rebuttals[${index}]`;
        if (!isRecord(raw)) {
          errors.push(`${field}: must be an object`);
          return;
        }
        const target = citationError(`${field}.targetTurnId`, raw.targetTurnId, context);
        if (target !== undefined) errors.push(target);
        if (!isText(raw.claim)) errors.push(`${field}.claim: must be a non-empty string`);
        if (!isText(raw.response)) errors.push(`${field}.response: must be a non-empty string`);
        if (target === undefined && isText(raw.claim) && isText(raw.response)) {
          rebuttals.push({
            targetTurnId: raw.targetTurnId as string,
            claim: raw.claim,
            response: raw.response,
          });
        }
      });
    }

    if (context.format.answerFormat === 'choice') {
      // D348: the engine decides, from the answers; the model's own flag is ignored.
      positionChanged =
        answer.ok &&
        context.ownPrevious !== undefined &&
        normaliseAnswer(answer.value) !== normaliseAnswer(context.ownPrevious.answer);
    } else if (typeof value.positionChanged === 'boolean') {
      positionChanged = value.positionChanged;
    } else {
      errors.push('positionChanged: must be true or false');
    }

    if (positionChanged) {
      const raw = value.changedBecause;
      if (!isRecord(raw)) {
        errors.push('changedBecause: required when positionChanged is true');
      } else {
        const cited = citationError('changedBecause.turnId', raw.turnId, context);
        if (cited !== undefined) errors.push(cited);
        if (!isText(raw.argument))
          errors.push('changedBecause.argument: must be a non-empty string');
        if (cited === undefined && isText(raw.argument)) {
          changedBecause = { turnId: raw.turnId as string, argument: raw.argument };
        }
      }
    }
  }

  if (errors.length > 0 || !answer.ok) return { ok: false, errors };
  return {
    ok: true,
    value: {
      turnId,
      round: context.round,
      label: context.label,
      answer: answer.value,
      confidence: value.confidence as number,
      reasoning: value.reasoning as string,
      rebuttals: context.round === 0 ? [] : rebuttals,
      positionChanged,
      changedBecause,
    },
  };
}

export interface VerdictContext {
  format: AnswerFormat;
  /** Every turn the judge was shown. */
  turnIds: ReadonlySet<string>;
  labels: ReadonlySet<string>;
}

export type VerdictReply = Omit<DebateVerdict, 'stats'>;

export function validateVerdictReply(
  value: unknown,
  context: VerdictContext,
): Checked<VerdictReply> {
  if (!isRecord(value)) return { ok: false, errors: ['the json block must be an object'] };
  const errors: string[] = [];

  const answer = checkAnswer(value.answer, context.format);
  if (!answer.ok) errors.push(...answer.errors);
  const confidenceError = checkConfidence(value.confidence);
  if (confidenceError !== undefined) errors.push(confidenceError);

  const rationale: DebateRationalePoint[] = [];
  if (!Array.isArray(value.rationale) || value.rationale.length === 0) {
    errors.push('rationale: at least one point is required');
  } else {
    value.rationale.forEach((raw: unknown, index) => {
      const field = `rationale[${index}]`;
      if (!isRecord(raw) || !isText(raw.point)) {
        errors.push(`${field}.point: must be a non-empty string`);
        return;
      }
      if (!Array.isArray(raw.supportedBy) || raw.supportedBy.length === 0) {
        errors.push(`${field}.supportedBy: cite at least one turn id, or "judge"`);
        return;
      }
      const cited: string[] = [];
      for (const id of raw.supportedBy as unknown[]) {
        if (typeof id === 'string' && (id === 'judge' || context.turnIds.has(id))) cited.push(id);
        else errors.push(`${field}.supportedBy: ${String(id)} is not a turn of this debate`);
      }
      rationale.push({ point: raw.point, supportedBy: cited });
    });
  }

  const dissent: DebateDissent[] = [];
  const rawDissent = value.dissent ?? [];
  if (!Array.isArray(rawDissent)) {
    errors.push('dissent: must be a list');
  } else {
    rawDissent.forEach((raw: unknown, index) => {
      const field = `dissent[${index}]`;
      if (!isRecord(raw)) {
        errors.push(`${field}: must be an object`);
        return;
      }
      const bad = [
        typeof raw.label === 'string' && context.labels.has(raw.label)
          ? undefined
          : `${field}.label: must be one of the debaters' labels`,
        isText(raw.answer) ? undefined : `${field}.answer: must be a non-empty string`,
        isText(raw.strongestArgument)
          ? undefined
          : `${field}.strongestArgument: must be a non-empty string`,
        typeof raw.turnId === 'string' && context.turnIds.has(raw.turnId)
          ? undefined
          : `${field}.turnId: ${String(raw.turnId)} is not a turn of this debate`,
      ].filter((error): error is string => error !== undefined);
      if (bad.length > 0) {
        errors.push(...bad);
        return;
      }
      dissent.push({
        label: raw.label as DebateLabel,
        answer: raw.answer as string,
        strongestArgument: raw.strongestArgument as string,
        turnId: raw.turnId as string,
      });
    });
  }

  const rawQuestions = value.openQuestions ?? [];
  const openQuestions: string[] = [];
  if (!Array.isArray(rawQuestions)) errors.push('openQuestions: must be a list of strings');
  else {
    for (const question of rawQuestions as unknown[]) {
      if (isText(question)) openQuestions.push(question);
      else errors.push('openQuestions: must be a list of non-empty strings');
    }
  }

  if (errors.length > 0 || !answer.ok) return { ok: false, errors };
  return {
    ok: true,
    value: {
      answer: answer.value,
      confidence: value.confidence as number,
      rationale,
      dissent,
      openQuestions,
    },
  };
}
