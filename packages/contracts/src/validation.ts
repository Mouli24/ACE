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
 *
 * From round 4 `incompatible_model` also covers file, image, audio and video inputs: an image on
 * its way to a text-only model is this code (round 4 §2.4, FR-MM-005, TC-MM-005).
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
 * it was refused with, the way `isConnectionAllowed`'s refusals are. Two are pre-flight's:
 * `daily_budget_exceeded`, when today's spend has reached `Settings.dailyBudgetUsd` (§2.3), and
 * `missing_upstream_output`, when Start from node needs an output no earlier run produced (D83).
 * `loop_not_supported` stays in round 1's list after A3 stops raising it, when loop edges are
 * accepted: codes are only ever added (NFR-VER-01).
 */
export const ROUND_3_VALIDATION_ISSUE_CODES = [
  ...LOOP_REFUSAL_CODES,
  'daily_budget_exceeded',
  'missing_upstream_output',
] as const;

/**
 * The codes round 4 §2.4 adds. `tool_not_registered` is an error: an agent has a tool enabled that
 * no longer exists, typically because its MCP server was removed (FR-TOOL-002, FR-TOOL-007).
 * `mcp_server_unreachable` is a **warning** — the run can proceed without that server's tools, the
 * way `missing_model` was a warning in round 1.
 *
 * Round 4 adds no code for a data type a model cannot accept: `incompatible_model` already covers
 * it and now also covers file, image, audio and video inputs (FR-MM-005), because codes are only
 * ever added, never repurposed away from a consumer (NFR-VER-01).
 */
export const ROUND_4_VALIDATION_ISSUE_CODES = [
  'tool_not_registered',
  'mcp_server_unreachable',
] as const;

/**
 * The code round 5 §2.4 adds, an error raised by pre-flight: a Retrieval node with no knowledge base
 * chosen, or a Retrieval node or an agent naming a base that no longer exists (FR-RAG-005,
 * FR-RAG-006). From round 5 pre-flight stops raising `not_supported_yet` for `retrieval`; the code
 * stays, for `guardrail` and `custom` (NFR-VER-01).
 */
export const ROUND_5_VALIDATION_ISSUE_CODES = ['missing_knowledge_base'] as const;

export const VALIDATION_ISSUE_CODES = [
  ...ROUND_1_VALIDATION_ISSUE_CODES,
  ...ROUND_2_VALIDATION_ISSUE_CODES,
  ...ROUND_3_VALIDATION_ISSUE_CODES,
  ...ROUND_4_VALIDATION_ISSUE_CODES,
  ...ROUND_5_VALIDATION_ISSUE_CODES,
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
