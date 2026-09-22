import type { DataType, ModelPricing, ModelSource, ProviderType } from '@ace/contracts';

import type { ModelInfo } from '../adapter.js';
import manifestFile from './manifest.json' with { type: 'json' };

/**
 * The model catalog (FR-MOD-001..006, Arch §14.4).
 *
 * Two sources, one list. A provider that can list its models is asked; a provider that cannot —
 * or a model it forgot to mention — is described by the versioned manifest that ships with the
 * engine. The manifest is also where prices live, stamped with a table version so an old run's
 * cost estimate never moves when the table does (FR-OBS-003).
 */

/** The price table this build of the manifest was written against. */
export const MANIFEST_PRICE_TABLE_VERSION: string = manifestFile.priceTableVersion;

export interface ManifestModel extends ModelInfo {
  pricing: ModelPricing;
}

function withVersion(entry: (typeof manifestFile.providers.anthropic)[number]): ManifestModel {
  return {
    modelId: entry.modelId,
    displayName: entry.displayName,
    inputTypes: entry.inputTypes as DataType[],
    outputTypes: entry.outputTypes as DataType[],
    contextWindow: entry.contextWindow,
    supportsTools: entry.supportsTools,
    supportsJson: entry.supportsJson,
    pricing: { ...entry.pricing, priceTableVersion: MANIFEST_PRICE_TABLE_VERSION },
  };
}

/** The manifest, keyed by provider type. Only the providers that need one appear. */
export const MANIFEST: Readonly<Record<string, ManifestModel[]>> = Object.fromEntries(
  Object.entries(manifestFile.providers).map(([type, entries]) => [type, entries.map(withVersion)]),
);

/** Manifest entries for one provider type — empty for a provider whose models are discovered. */
export function manifestFor(type: ProviderType): ManifestModel[] {
  return (MANIFEST[type] ?? []).map((model) => ({ ...model }));
}

export interface CatalogEntry extends ModelInfo {
  source: ModelSource;
}

/**
 * Merge what a provider listed with what the manifest knows (FR-MOD-001, FR-MOD-002).
 *
 * A discovered model wins on identity and display name — it is the provider's own word for what
 * exists today — and the manifest fills in everything a listing does not carry: data types,
 * context window and price. A manifest model nobody listed is still offered, marked `manifest`,
 * because a provider without a listing endpoint would otherwise have an empty catalog.
 */
export function mergeCatalog(
  discovered: readonly ModelInfo[],
  manifest: readonly ManifestModel[],
): CatalogEntry[] {
  const byId = new Map(manifest.map((model) => [model.modelId, model]));
  const seen = new Set<string>();
  const merged: CatalogEntry[] = [];

  for (const model of discovered) {
    if (seen.has(model.modelId)) continue;
    seen.add(model.modelId);

    const known = byId.get(model.modelId);
    merged.push(
      known === undefined
        ? { ...model, source: 'discovered' }
        : { ...known, displayName: model.displayName, source: 'discovered' },
    );
  }

  for (const model of manifest) {
    if (seen.has(model.modelId)) continue;
    seen.add(model.modelId);
    merged.push({ ...model, source: 'manifest' });
  }

  return merged;
}
