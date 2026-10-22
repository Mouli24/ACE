import { describe, expect, it } from 'vitest';

import { DATA_TYPES, type DataType } from '../enums.js';
import { LOOP_REFUSAL_CODES, type Port } from '../graph.js';
import {
  ROUND_1_VALIDATION_ISSUE_CODES,
  ROUND_3_VALIDATION_ISSUE_CODES,
  ROUND_4_VALIDATION_ISSUE_CODES,
  AGENTIC_VALIDATION_ISSUE_CODES,
  COST_VALIDATION_ISSUE_CODES,
  ROUND_5_VALIDATION_ISSUE_CODES,
  PRODUCT_GAPS_VALIDATION_ISSUE_CODES,
  RUN_ORDER_VALIDATION_ISSUE_CODES,
  VALIDATION_ISSUE_CODES,
  ValidationIssueCodeSchema,
  ValidationIssueSchema,
  isConnectionAllowed,
} from '../validation.js';
import { NODE_A, NODE_B } from './fixtures.js';

const source = (dataType: DataType): Port => ({
  id: NODE_A + ':out:' + dataType,
  name: dataType,
  dataType,
  multi: true,
});

const target = (dataType: DataType, multi = false): Port => ({
  id: NODE_B + ':in:' + dataType,
  name: dataType,
  dataType,
  multi,
});

describe('TC-CON-002 Type mismatch', () => {
  it('refuses a text output into an image-only input, with a reason', () => {
    const result = isConnectionAllowed(source('text'), target('image'), 0);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('incompatible_types');
    expect(result.reason).toContain('text');
    expect(result.reason).toContain('image');
  });

  it.each(DATA_TYPES)('allows %s into a port of the same type', (dataType) => {
    expect(isConnectionAllowed(source(dataType), target(dataType), 0)).toEqual({ ok: true });
  });

  it('allows code into text and text into code, the only cross-type pair §2.5 permits', () => {
    expect(isConnectionAllowed(source('code'), target('text'), 0)).toEqual({ ok: true });
    expect(isConnectionAllowed(source('text'), target('code'), 0)).toEqual({ ok: true });
  });

  it.each([
    ['text', 'json'],
    ['json', 'text'],
    ['image', 'video'],
    ['code', 'json'],
    ['file', 'text'],
    ['audio', 'video'],
  ] as const)('refuses %s into %s', (from, to) => {
    const result = isConnectionAllowed(source(from), target(to), 0);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('incompatible_types');
  });
});

describe('TC-CON-005 Fan-out', () => {
  it('lets a multi input take a third, fourth and fifth edge', () => {
    for (const existing of [0, 1, 2, 3, 4]) {
      expect(isConnectionAllowed(source('text'), target('text', true), existing)).toEqual({
        ok: true,
      });
    }
  });

  it('lets one output feed several targets (the source side is never the limit)', () => {
    const out = source('text');
    expect(isConnectionAllowed(out, target('text'), 0)).toEqual({ ok: true });
    expect(isConnectionAllowed(out, { ...target('text'), id: 'x' }, 0)).toEqual({ ok: true });
  });
});

describe('TC-CON-006 Single-input port', () => {
  it('accepts the first edge into a single input', () => {
    expect(isConnectionAllowed(source('text'), target('text'), 0)).toEqual({ ok: true });
  });

  it('refuses the second edge into a single input, with a reason', () => {
    const result = isConnectionAllowed(source('text'), target('text'), 1);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('single_input_occupied');
    expect(result.reason.length).toBeGreaterThan(0);
  });

  it('reports the type mismatch first when a port is both mismatched and occupied', () => {
    const result = isConnectionAllowed(source('text'), target('image'), 1);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('incompatible_types');
  });
});

describe('FR-WF-006 ValidationIssue', () => {
  it('declares exactly the codes of round 1 §2.5', () => {
    expect([...ROUND_1_VALIDATION_ISSUE_CODES]).toEqual([
      'unconnected_required_input',
      'no_input_node',
      'no_output_node',
      'incompatible_types',
      'cycle',
      'single_input_occupied',
      'invalid_execution_setting',
      'missing_model',
      'loop_not_supported',
    ]);
  });

  it('adds the seven codes round 2 §2.5 names, then rounds 3, 4 and 5', () => {
    expect([...VALIDATION_ISSUE_CODES]).toEqual([
      ...ROUND_1_VALIDATION_ISSUE_CODES,
      'provider_missing',
      'provider_unreachable',
      'unavailable_model',
      'incompatible_model',
      'missing_input',
      'not_supported_yet',
      'unknown_placeholder',
      ...ROUND_3_VALIDATION_ISSUE_CODES,
      ...ROUND_4_VALIDATION_ISSUE_CODES,
      ...ROUND_5_VALIDATION_ISSUE_CODES,
      ...PRODUCT_GAPS_VALIDATION_ISSUE_CODES,
      ...RUN_ORDER_VALIDATION_ISSUE_CODES,
      ...AGENTIC_VALIDATION_ISSUE_CODES,
      ...COST_VALIDATION_ISSUE_CODES,
    ]);
  });

  it('PG-1.3 adds missing_provider (D358) beside missing_model and provider_missing', () => {
    // D353 (PG-2.1) adds the two blocked-combination codes after it, and PG-2.4 (D361)
    // checkpoint_unavailable and running_without_undo.
    expect([...PRODUCT_GAPS_VALIDATION_ISSUE_CODES]).toEqual([
      'missing_provider',
      'schema_unsupported',
      'tools_unsupported',
      'checkpoint_unavailable',
      'running_without_undo',
    ]);
    expect(ValidationIssueCodeSchema.safeParse('missing_provider').success).toBe(true);
    expect(VALIDATION_ISSUE_CODES).toContain('missing_model');
    expect(VALIDATION_ISSUE_CODES).toContain('provider_missing');
  });

  it('agentic nodes Phase 2 adds model_cannot_use_tools and project_folder_missing', () => {
    expect([...AGENTIC_VALIDATION_ISSUE_CODES]).toEqual([
      'model_cannot_use_tools',
      'project_folder_missing',
    ]);
    // [audit E-4] The cost warning's code comes after them.
    expect(VALIDATION_ISSUE_CODES.slice(-3, -1)).toEqual([...AGENTIC_VALIDATION_ISSUE_CODES]);
    expect(ValidationIssueCodeSchema.safeParse('project_folder_missing').success).toBe(true);
  });

  it('[audit E-4, P-3] adds unpriced_model_under_cap, the warning a cost cap over an unpriced model gets', () => {
    expect([...COST_VALIDATION_ISSUE_CODES]).toEqual(['unpriced_model_under_cap']);
    expect(VALIDATION_ISSUE_CODES.slice(-1)).toEqual([...COST_VALIDATION_ISSUE_CODES]);
    expect(ValidationIssueCodeSchema.safeParse('unpriced_model_under_cap').success).toBe(true);
  });

  it('adds the one code round 5 §2.4 names, and keeps not_supported_yet for later kinds', () => {
    expect([...ROUND_5_VALIDATION_ISSUE_CODES]).toEqual(['missing_knowledge_base']);
    expect(ValidationIssueCodeSchema.safeParse('missing_knowledge_base').success).toBe(true);
    expect(VALIDATION_ISSUE_CODES).toContain('not_supported_yet');
  });

  it('adds the two codes round 4 §2.4 names, and repurposes none', () => {
    expect([...ROUND_4_VALIDATION_ISSUE_CODES]).toEqual([
      'tool_not_registered',
      'mcp_server_unreachable',
    ]);
    expect(VALIDATION_ISSUE_CODES).toContain('incompatible_model');
  });

  it('FR-CON-007 reports a refused loop edge by the code validateLoopConfig gives it', () => {
    expect([...ROUND_3_VALIDATION_ISSUE_CODES]).toEqual(
      expect.arrayContaining([...LOOP_REFUSAL_CODES]),
    );
    for (const code of LOOP_REFUSAL_CODES) {
      expect(ValidationIssueCodeSchema.safeParse(code).success, code).toBe(true);
    }
  });

  it('FR-EXE-013 names a start node whose upstream never produced an output (D83)', () => {
    expect(ROUND_3_VALIDATION_ISSUE_CODES).toContain('missing_upstream_output');
    expect(ValidationIssueCodeSchema.safeParse('missing_upstream_output').success).toBe(true);
  });

  it('FR-GRD-008 names a run pre-flight blocks because the daily budget is spent', () => {
    expect(ROUND_3_VALIDATION_ISSUE_CODES).toContain('daily_budget_exceeded');
    expect(ValidationIssueCodeSchema.safeParse('daily_budget_exceeded').success).toBe(true);
  });

  it('keeps loop_not_supported, which A3 retires — codes are only ever added (NFR-VER-01)', () => {
    expect(VALIDATION_ISSUE_CODES).toContain('loop_not_supported');
  });

  it('parses a pre-flight issue that names the node it blocks', () => {
    const issue = {
      severity: 'error',
      code: 'incompatible_model',
      message: 'mock-text cannot read image input',
      nodeId: NODE_A,
    };

    expect(ValidationIssueSchema.parse(issue)).toEqual(issue);
    expect(ValidationIssueCodeSchema.safeParse('incompatible_model').success).toBe(true);
    expect(ValidationIssueCodeSchema.safeParse('model_is_wrong').success).toBe(false);
  });

  it('accepts an issue with a node id and one with an edge id', () => {
    const nodeIssue = {
      severity: 'error',
      code: 'no_input_node',
      message: 'add an Input node',
      nodeId: NODE_A,
    };
    const edgeIssue = {
      severity: 'warning',
      code: 'cycle',
      message: 'A -> B -> A',
      edgeId: NODE_B,
    };

    expect(ValidationIssueSchema.parse(nodeIssue)).toEqual(nodeIssue);
    expect(ValidationIssueSchema.parse(edgeIssue)).toEqual(edgeIssue);
  });

  it('accepts an issue with neither id', () => {
    expect(
      ValidationIssueSchema.safeParse({
        severity: 'error',
        code: 'no_output_node',
        message: 'add an Output node',
      }).success,
    ).toBe(true);
  });

  it('rejects a severity that is neither error nor warning', () => {
    expect(
      ValidationIssueSchema.safeParse({ severity: 'info', code: 'cycle', message: 'x' }).success,
    ).toBe(false);
  });

  it('rejects a node id that is not a ULID', () => {
    expect(
      ValidationIssueSchema.safeParse({
        severity: 'error',
        code: 'cycle',
        message: 'x',
        nodeId: 'node-1',
      }).success,
    ).toBe(false);
  });
});
