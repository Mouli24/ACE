import { z } from 'zod';

import type { DataType } from './enums.js';
import { IdSchema, LOOP_REFUSAL_CODES, type Port } from './graph.js';

/* -------------------------------------------------------------------------- */
/* Connection rule (FR-CON-002 / FR-CON-005, round 1 §2.5)                     */
/* -------------------------------------------------------------------------- */

/**
 * The only cross-type pairs §2.5 permits. Every other connection needs identical data types.
 */
const CROSS_TYPE_PAIRS: ReadonlyArray<readonly [DataType, DataType]> = [
  ['code', 'text'],
  ['text', 'code'],
];

export type ConnectionRefusalCode = 'incompatible_types' | 'single_input_occupied';

export type ConnectionCheck =
  | { ok: true }
  | { ok: false; code: ConnectionRefusalCode; reason: string };

function typesAreCompatible(from: DataType, to: DataType): boolean {
  if (from === to) return true;
  return CROSS_TYPE_PAIRS.some(([a, b]) => a === from && b === to);
}

/**
 * Decide whether an edge may be drawn from `source` to `target` (pure — the engine and the Canvas
 * must reach the same verdict).
 *
 * Type compatibility is checked before port occupancy, so a mismatched type into an already-full
 * single input reports `incompatible_types`: the type is the reason the edge can never work,
 * whereas occupancy is something the user can clear by deleting the other edge.
 */
export function isConnectionAllowed(
  source: Port,
  target: Port,
  existingEdgesIntoTarget: number,
): ConnectionCheck {
  if (!typesAreCompatible(source.dataType, target.dataType)) {
    return {
      ok: false,
      code: 'incompatible_types',
      reason: `Cannot connect ${source.dataType} output "${source.name}" to ${target.dataType} input "${target.name}".`,
    };
  }

  if (!target.multi && existingEdgesIntoTarget >= 1) {
    return {
      ok: false,
      code: 'single_input_occupied',
      reason: `Input "${target.name}" already has a connection and accepts only one.`,
    };
  }

  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/* Validation issues (FR-WF-006, round 1 §2.5)                                 */
/* -------------------------------------------------------------------------- */

/**
 * The issue codes round 1 §2.5 lists, in its order. `missing_model` is a warning this round and
 * becomes an error from round 2; `loop_not_supported` exists only while loop edges are refused.
 */
export const ROUND_1_VALIDATION_ISSUE_CODES = [
  'unconnected_required_input',
  'no_input_node',
  'no_output_node',
  'incompatible_types',
  'cycle',
  'single_input_occupied',
  'invalid_execution_setting',
  'missing_model',
  'loop_not_supported',
] as const;

/**
 * The codes round 2 §2.5 adds. The first four are raised by `/validate`; `missing_input`,
 * `not_supported_yet` and `unknown_placeholder` are raised by pre-flight (§2.7) and land on the
 * run as `preflightIssues`. `not_supported_yet` is removed code by code as later rounds land.
 */
export const ROUND_2_VALIDATION_ISSUE_CODES = [
  'provider_missing',
  'provider_unreachable',
  'unavailable_model',
  'incompatible_model',
  'missing_input',
  'not_supported_yet',
  'unknown_placeholder',
] as const;

/**
 * The codes round 3 adds. A loop edge `validateLoopConfig` refuses (§2.4) is reported by the code
 * it was refused with, the way `isConnectionAllowed`'s refusals are. `loop_not_supported` stays in
 * round 1's list although the engine no longer raises it: codes are only ever added (NFR-VER-01).
 */
export const ROUND_3_VALIDATION_ISSUE_CODES = [...LOOP_REFUSAL_CODES] as const;

export const VALIDATION_ISSUE_CODES = [
  ...ROUND_1_VALIDATION_ISSUE_CODES,
  ...ROUND_2_VALIDATION_ISSUE_CODES,
  ...ROUND_3_VALIDATION_ISSUE_CODES,
] as const;
export const ValidationIssueCodeSchema = z.enum(VALIDATION_ISSUE_CODES);
export type ValidationIssueCode = z.infer<typeof ValidationIssueCodeSchema>;

export const VALIDATION_SEVERITIES = ['error', 'warning'] as const;
export const ValidationSeveritySchema = z.enum(VALIDATION_SEVERITIES);
export type ValidationSeverity = z.infer<typeof ValidationSeveritySchema>;

export const ValidationIssueSchema = z.object({
  severity: ValidationSeveritySchema,
  code: z.string(),
  message: z.string(),
  nodeId: IdSchema.optional(),
  edgeId: IdSchema.optional(),
});
export type ValidationIssue = z.infer<typeof ValidationIssueSchema>;
