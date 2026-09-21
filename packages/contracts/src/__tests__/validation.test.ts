import { describe, expect, it } from 'vitest';

import { DATA_TYPES, type DataType } from '../enums.js';
import type { Port } from '../graph.js';
import {
  VALIDATION_ISSUE_CODES,
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
    expect([...VALIDATION_ISSUE_CODES]).toEqual([
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
