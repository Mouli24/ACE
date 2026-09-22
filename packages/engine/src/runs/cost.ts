import type { ModelPricing, Usage } from '@ace/contracts';

/**
 * Cost estimation (FR-OBS-002, FR-OBS-003, Arch §27).
 *
 * The price table version travels with every estimate. That is the whole point of FR-OBS-003: a
 * run priced last month must still show last month's number after the table changes, so the cost
 * is computed once, at the time, from a version that is frozen in the store.
 */

export const TOKENS_PER_PRICE_UNIT = 1000;

/** What this many tokens cost at these prices. Zero when the model has no published price. */
export function estimateCostUsd(
  tokensIn: number,
  tokensOut: number,
  pricing: ModelPricing | undefined,
): number {
  if (pricing === undefined) return 0;

  return (
    (tokensIn / TOKENS_PER_PRICE_UNIT) * pricing.inputPer1k +
    (tokensOut / TOKENS_PER_PRICE_UNIT) * pricing.outputPer1k
  );
}

/** A priced `Usage`, stamped with the table it was priced against. */
export function usageFor(
  tokensIn: number,
  tokensOut: number,
  pricing: ModelPricing | undefined,
): Usage {
  return {
    tokensIn,
    tokensOut,
    costUsd: estimateCostUsd(tokensIn, tokensOut, pricing),
    ...(pricing === undefined ? {} : { priceTableVersion: pricing.priceTableVersion }),
  };
}

/**
 * Run totals are the exact sum of the node runs (FR-OBS-002, TC-OBS-002).
 *
 * The version is carried through only while every priced node agrees on one; a run that used two
 * price tables reports none rather than picking a winner, because neither would be the truth.
 */
export function sumUsage(usages: readonly Usage[]): Usage {
  const versions = new Set(
    usages.flatMap((usage) => (usage.priceTableVersion === undefined ? [] : [usage.priceTableVersion])),
  );

  const total = usages.reduce(
    (sum, usage) => ({
      tokensIn: sum.tokensIn + usage.tokensIn,
      tokensOut: sum.tokensOut + usage.tokensOut,
      costUsd: sum.costUsd + usage.costUsd,
    }),
    { tokensIn: 0, tokensOut: 0, costUsd: 0 },
  );

  return {
    ...total,
    ...(versions.size === 1 ? { priceTableVersion: [...versions][0]! } : {}),
  };
}
