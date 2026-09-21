import { EXECUTION_RANGES, validateNumber } from './validation';

describe('execution setting ranges (FR-NODE-007, §2.4 ExecutionSettings)', () => {
  it('mirrors the contract bounds', () => {
    expect(EXECUTION_RANGES.temperature).toMatchObject({ min: 0, max: 2, integer: false });
    expect(EXECUTION_RANGES.maxTokens).toMatchObject({ min: 1, max: 200_000, integer: true });
    expect(EXECUTION_RANGES.timeoutMs).toMatchObject({ min: 1000, max: 600_000, integer: true });
    expect(EXECUTION_RANGES.retries).toMatchObject({ min: 0, max: 5, integer: true });
  });

  it('validateNumber names the range and rejects non-integers where required', () => {
    expect(validateNumber('5', EXECUTION_RANGES.temperature)).toMatch(/between 0 and 2/);
    expect(validateNumber('1.5', EXECUTION_RANGES.temperature)).toBeUndefined();
    expect(validateNumber('2.5', EXECUTION_RANGES.retries)).toMatch(/whole number/);
    expect(validateNumber('', EXECUTION_RANGES.retries)).toMatch(/required/i);
    expect(validateNumber('abc', EXECUTION_RANGES.retries)).toMatch(/number/i);
    expect(validateNumber('3', EXECUTION_RANGES.retries)).toBeUndefined();
  });
});
