import {
  GUARDRAIL_CHECK_TYPES,
  GUARDRAIL_CHECK_TYPES_BY_POINT,
  GuardrailCheckSchema,
  POLICY_GUARDRAIL_POINTS,
} from '@ace/contracts';

import {
  CHECK_PARAM_FIELDS,
  EDITOR_POINT_ORDER,
  POINT_DESCRIPTION,
  POINT_LABEL,
  checkTypesFor,
  numberToText,
  patternsToText,
  textToPatterns,
  unknownParams,
} from './check-meta';

describe('FR-GRD-001 the editor covers the contract, and only the contract', () => {
  it('groups by every policy point and no others', () => {
    expect([...EDITOR_POINT_ORDER].sort()).toEqual([...POLICY_GUARDRAIL_POINTS].sort());
    for (const point of POLICY_GUARDRAIL_POINTS) {
      expect(POINT_LABEL[point]).toBeTruthy();
      expect(POINT_DESCRIPTION[point]).toBeTruthy();
    }
  });

  it('offers at a point exactly the check types the contract allows there', () => {
    for (const point of POLICY_GUARDRAIL_POINTS) {
      expect(checkTypesFor(point)).toEqual(GUARDRAIL_CHECK_TYPES_BY_POINT[point]);
      for (const type of checkTypesFor(point)) {
        expect(
          GuardrailCheckSchema.safeParse({
            id: '01J0000000000000000000000A',
            point,
            type,
            action: 'warn',
            enabled: true,
            params: {},
          }).success,
        ).toBe(true);
      }
    }
  });

  it('has a params list for every check type, so a row cannot crash on an unknown one', () => {
    for (const type of GUARDRAIL_CHECK_TYPES) {
      expect(CHECK_PARAM_FIELDS[type]).toBeDefined();
    }
  });
});

describe('FR-GRD-011 params survive the round trip through the form', () => {
  it('keeps params the form has no field for', () => {
    expect(
      unknownParams({
        id: '01J0000000000000000000000A',
        point: 'input',
        type: 'size_limit',
        action: 'warn',
        enabled: true,
        params: { maxChars: 10, somethingElse: 'kept' },
      }),
    ).toEqual({ somethingElse: 'kept' });
  });

  it('reads a number param as a form value and an absent one as an empty box', () => {
    expect(numberToText(12)).toBe('12');
    expect(numberToText(undefined)).toBe('');
    expect(numberToText('12')).toBe('');
  });

  it('turns a pattern list into lines and back, dropping blank lines', () => {
    expect(patternsToText(['a', 'b'])).toBe('a\nb');
    expect(patternsToText(undefined)).toBe('');
    expect(textToPatterns(' a \n\n b ')).toEqual(['a', 'b']);
    expect(textToPatterns('  ')).toEqual([]);
  });
});
