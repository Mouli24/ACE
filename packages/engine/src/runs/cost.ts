import { providerGroup, type ModelPricing, type ProviderType, type Usage } from '@ace/contracts';

/**
 * Cost estimation (FR-OBS-002, FR-OBS-003, Arch §27).
 *
 * The price table version travels with every estimate. That is the whole point of FR-OBS-003: a
 * run priced last month must still show last month's number after the table changes, so the cost
 * is computed once, at the time, from a version that is frozen in the store.
 *
 * PG-1.4 (D359): a local model (Ollama, or an OpenAI-compatible server on this machine or the LAN)
 * costs $0 by rule, whatever its catalog row says; a remote model with no price has an **unknown**
 * cost (`costKnown: false`), never a silent $0.
 */

export const TOKENS_PER_PRICE_UNIT = 1000;

/** What the cost rule needs to know about the provider that answered. */
export interface PricedProvider {
  type: ProviderType;
  baseUrl?: string | undefined;
}

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

/**
 * A priced `Usage`, stamped with the table it was priced against.
 *
 * With the provider known, PG-1.4's rule applies: local is $0 by rule; an unpriced cloud, CLI or
 * custom-endpoint model is `costKnown: false`. The test provider (`mock`) and a caller that does
 * not name the provider keep the plain table rule.
 */
export function usageFor(
  tokensIn: number,
  tokensOut: number,
  pricing: ModelPricing | undefined,
  provider?: PricedProvider,
): Usage {
  const group = provider === undefined ? undefined : providerGroup(provider);
  if (group === 'local') return { tokensIn, tokensOut, costUsd: 0 };
  const unknown = pricing === undefined && group !== undefined && group !== 'mock';
  return {
    tokensIn,
    tokensOut,
    costUsd: estimateCostUsd(tokensIn, tokensOut, pricing),
    ...(pricing === undefined ? {} : { priceTableVersion: pricing.priceTableVersion }),
    ...(unknown ? { costKnown: false } : {}),
  };
}

/** A usage whose cost the provider reported itself (D263): known, whatever the table said. */
export function withReportedCost(usage: Usage, costUsd: number): Usage {
  const { costKnown: _dropped, ...rest } = usage;
  return { ...rest, costUsd, costSource: 'reported' };
}

/**
 * Run totals are the exact sum of the node runs (FR-OBS-002, TC-OBS-002).
 *
 * The version is carried through only while every priced node agrees on one; a run that used two
 * price tables reports none rather than picking a winner, because neither would be the truth.
 * PG-1.4: a total with any part of unknown cost is itself unknown; its `costUsd` is then only the
 * part that is known.
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
    ...(usages.some((usage) => usage.costKnown === false) ? { costKnown: false } : {}),
  };
}
