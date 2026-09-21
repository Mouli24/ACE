export interface NumberRange {
  min: number;
  max: number;
  integer: boolean;
}

/** §2.4 `ExecutionSettings` bounds, the same numbers the contract schema enforces (FR-NODE-007). */
export const EXECUTION_RANGES = {
  temperature: { min: 0, max: 2, integer: false },
  maxTokens: { min: 1, max: 200_000, integer: true },
  timeoutMs: { min: 1000, max: 600_000, integer: true },
  retries: { min: 0, max: 5, integer: true },
} as const satisfies Record<string, NumberRange>;

/** §2.4 `contextPolicy.budgetTokens`. */
export const BUDGET_RANGE: NumberRange = { min: 256, max: 200_000, integer: true };

/** Returns the inline error for a raw input value, or `undefined` when it is in range. */
export function validateNumber(raw: string, range: NumberRange): string | undefined {
  if (raw.trim() === '') return 'A value is required.';
  const value = Number(raw);
  if (!Number.isFinite(value)) return 'Enter a number.';
  if (range.integer && !Number.isInteger(value)) return 'Enter a whole number.';
  if (value < range.min || value > range.max)
    return `Must be between ${range.min} and ${range.max}.`;
  return undefined;
}
