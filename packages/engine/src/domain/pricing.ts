import type { DomainCost, PricingEntry, PricingTable, ProviderType, Usage } from '@ace/contracts';

/**
 * A turn's cost in Domain (D306): what the provider reported, else an estimate from
 * `ace.pricing.json`, else nothing — `null`, shown "—", never 0. The catalog's built-in price
 * table is not used here; Track keeps using it.
 */

/** The table's entry for this provider type and the first of the model ids it prices. */
export function findPrice(
  table: PricingTable,
  providerType: ProviderType | undefined,
  modelIds: readonly (string | undefined)[],
): PricingEntry | undefined {
  if (providerType === undefined) return undefined;
  for (const modelId of modelIds) {
    if (modelId === undefined) continue;
    const entry = table.models.find(
      (model) => model.provider === providerType && model.model === modelId,
    );
    if (entry !== undefined) return entry;
  }
  return undefined;
}

export function costOfTurn(
  usage: Usage,
  table: PricingTable,
  providerType: ProviderType | undefined,
  modelIds: readonly (string | undefined)[],
): DomainCost | null {
  if (usage.costSource === 'reported') {
    return { usd: usage.costUsd, source: 'reported', partial: false };
  }
  const entry = findPrice(table, providerType, modelIds);
  if (entry === undefined) return null;
  const usd = (usage.tokensIn * entry.inputPer1M + usage.tokensOut * entry.outputPer1M) / 1_000_000;
  return { usd, source: 'estimated', partial: false };
}

/**
 * The sum of several costs. `null` when none is known; `partial` when some are missing, so the
 * total is a floor; `mixed` when reported and estimated costs were added together.
 */
export function sumCosts(costs: readonly (DomainCost | null)[]): DomainCost | null {
  const known = costs.filter((cost): cost is DomainCost => cost !== null);
  if (known.length === 0) return null;
  const sources = new Set(known.map((cost) => cost.source));
  const [only] = sources;
  return {
    usd: known.reduce((sum, cost) => sum + cost.usd, 0),
    source: sources.size === 1 && only !== undefined ? only : 'mixed',
    partial: known.length < costs.length || known.some((cost) => cost.partial),
  };
}
