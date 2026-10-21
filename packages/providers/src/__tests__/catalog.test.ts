import { describe, expect, it } from 'vitest';

import {
  MANIFEST,
  MANIFEST_PRICE_TABLE_VERSION,
  NOT_OFFERED_REASON,
  manifestFor,
  mergeCatalog,
  type ManifestModel,
} from '../catalog/index.js';
import { discoveredModel } from '../adapters/ai-sdk.js';

describe('FR-MOD-002 the versioned manifest describes what discovery cannot', () => {
  it('covers the three cloud providers', () => {
    expect(Object.keys(MANIFEST).sort()).toEqual(['anthropic', 'google', 'openai']);
  });

  it('gives every manifest model the fields FR-MOD-003 requires', () => {
    for (const [type, models] of Object.entries(MANIFEST)) {
      expect(models.length, type).toBeGreaterThan(0);

      for (const model of models) {
        expect(model.modelId, type).toBeTruthy();
        expect(model.displayName, model.modelId).toBeTruthy();
        expect(model.inputTypes.length, model.modelId).toBeGreaterThan(0);
        expect(model.outputTypes.length, model.modelId).toBeGreaterThan(0);
        expect(model.contextWindow, model.modelId).toBeGreaterThan(0);
        expect(typeof model.supportsTools, model.modelId).toBe('boolean');
        expect(typeof model.supportsJson, model.modelId).toBe('boolean');
      }
    }
  });

  it('prices every manifest model against one table version (FR-OBS-003)', () => {
    for (const models of Object.values(MANIFEST)) {
      for (const model of models) {
        expect(model.pricing?.priceTableVersion, model.modelId).toBe(MANIFEST_PRICE_TABLE_VERSION);
        expect(model.pricing?.inputPer1k, model.modelId).toBeGreaterThan(0);
        expect(model.pricing?.outputPer1k, model.modelId).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('declares a vision model, so an image input has somewhere to go', () => {
    const vision = Object.values(MANIFEST)
      .flat()
      .filter((model) => model.inputTypes.includes('image'));

    expect(vision.length).toBeGreaterThan(0);
  });

  it('has nothing for a provider whose models are always discovered', () => {
    expect(manifestFor('openai_compatible')).toEqual([]);
    expect(manifestFor('ollama')).toEqual([]);
    expect(manifestFor('mock')).toEqual([]);
  });
});

describe('TC-MOD-001 / TC-MOD-002 discovery and manifest merge into one catalog', () => {
  const manifest = manifestFor('anthropic');
  const known = manifest[0]!;

  it('marks a model the provider listed as discovered', () => {
    const merged = mergeCatalog([discoveredModel(known.modelId)], manifest);
    const row = merged.find((model) => model.modelId === known.modelId);

    expect(row?.source).toBe('discovered');
  });

  it('fills a discovered model out from the manifest, since a listing has no types or prices', () => {
    const merged = mergeCatalog([discoveredModel(known.modelId)], manifest);
    const row = merged.find((model) => model.modelId === known.modelId);

    expect(row?.contextWindow).toBe(known.contextWindow);
    expect(row?.inputTypes).toEqual(known.inputTypes);
    expect(row?.pricing).toEqual(known.pricing);
  });

  it('keeps the provider display name over the manifest one', () => {
    const merged = mergeCatalog([discoveredModel(known.modelId, 'Newer Name')], manifest);

    expect(merged.find((m) => m.modelId === known.modelId)?.displayName).toBe('Newer Name');
  });

  it('keeps a discovered model the manifest has never heard of', () => {
    const merged = mergeCatalog([discoveredModel('claude-experimental-9')], manifest);
    const row = merged.find((model) => model.modelId === 'claude-experimental-9');

    expect(row?.source).toBe('discovered');
    expect(row?.inputTypes).toEqual(['text']);
  });

  it('keeps a manifest model the provider did not list, marked manifest', () => {
    const merged = mergeCatalog([], manifest);

    expect(merged).toHaveLength(manifest.length);
    expect(new Set(merged.map((model) => model.source))).toEqual(new Set(['manifest']));
  });

  it('lists discovered models before manifest-only ones', () => {
    const merged = mergeCatalog([discoveredModel('brand-new')], manifest);

    expect(merged[0]?.modelId).toBe('brand-new');
    expect(merged.slice(1).every((model) => model.source === 'manifest')).toBe(true);
  });

  it('never lists the same model twice', () => {
    const merged = mergeCatalog([discoveredModel(known.modelId), discoveredModel(known.modelId)], manifest);
    const ids = merged.map((model) => model.modelId);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('is what TC-MOD-002 asserts: a provider with no listing still has models', () => {
    expect(mergeCatalog([], manifestFor('openai')).length).toBeGreaterThan(0);
  });
});

describe('audit P-5 a listing says what this key may use', () => {
  const manifest = manifestFor('anthropic');
  const [first, second] = manifest as [ManifestModel, ManifestModel];

  it('marks a manifest model the listing left out unavailable, with why', () => {
    const merged = mergeCatalog([discoveredModel(first.modelId)], manifest);
    const missing = merged.find((model) => model.modelId === second.modelId);

    expect(merged.find((model) => model.modelId === first.modelId)?.available).toBeUndefined();
    expect(missing).toMatchObject({
      source: 'manifest',
      available: false,
      unavailableReason: NOT_OFFERED_REASON,
    });
  });

  it('counts a dated snapshot as offering the model it dates', () => {
    const merged = mergeCatalog(
      [discoveredModel(`${first.modelId}-20250929`), discoveredModel('gpt-5-2025-08-07')],
      [...manifest, ...manifestFor('openai')],
    );

    expect(merged.find((model) => model.modelId === first.modelId)?.available).toBeUndefined();
    expect(merged.find((model) => model.modelId === 'gpt-5')?.available).toBeUndefined();
    expect(merged.find((model) => model.modelId === 'gpt-5-mini')?.available).toBe(false);
  });

  it('offers the whole manifest when nothing was listed, as before', () => {
    expect(mergeCatalog([], manifest).every((model) => model.available === undefined)).toBe(true);
  });
});
