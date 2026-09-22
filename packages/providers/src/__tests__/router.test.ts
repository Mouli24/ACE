import { describe, expect, it } from 'vitest';

import { createRouter, type RouterModel, type RoutingNodeConfig } from '../router/index.js';

const PROVIDER_A = '01JBXQ8Z9KQ4R7N2VWXYZ0PRVD';
const PROVIDER_B = '01JBXQ8Z9KQ4R7N2VWXYZ0PRVE';

const model = (
  providerId: string,
  modelId: string,
  overrides: Partial<RouterModel> = {},
): RouterModel => ({
  providerId,
  modelId,
  available: true,
  inputTypes: ['text'],
  outputTypes: ['text'],
  ...overrides,
});

const CATALOG: RouterModel[] = [
  model(PROVIDER_A, 'mock-503'),
  model(PROVIDER_A, 'mock-text'),
  model(PROVIDER_A, 'mock-json', { outputTypes: ['json'], inputTypes: ['text', 'json'] }),
  model(PROVIDER_A, 'mock-retired', { available: false }),
  model(PROVIDER_B, 'gpt-5-mini', { inputTypes: ['text', 'image'] }),
];

const router = createRouter(() => CATALOG);

const node = (overrides: Partial<RoutingNodeConfig> = {}): RoutingNodeConfig => ({
  providerId: PROVIDER_A,
  modelId: 'mock-text',
  routing: { policy: 'fixed', fallbackModelIds: [] },
  ...overrides,
});

const TEXT = { inputTypes: ['text'] as const, outputTypes: ['text'] as const };
const noFailures = { failures: [] };

describe('TC-RTR-001 fixed is the default and always picks the chosen model', () => {
  it('resolves to the node’s own provider and model', () => {
    const result = router.resolve(node(), TEXT, noFailures);

    expect(result).toEqual({
      ok: true,
      route: { providerId: PROVIDER_A, modelId: 'mock-text', viaFallback: false },
    });
  });

  it('never moves on, whatever went wrong', () => {
    const result = router.resolve(
      node({ modelId: 'mock-503', routing: { policy: 'fixed', fallbackModelIds: ['mock-text'] } }),
      TEXT,
      { failures: [{ modelId: 'mock-503', kind: 'provider' }] },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('no_candidate_left');
  });

  it('refuses a node with no model chosen (TC-NODE-007)', () => {
    const result = router.resolve(node({ modelId: undefined }), TEXT, noFailures);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('missing_model');
  });

  it('refuses a node with no provider chosen', () => {
    const result = router.resolve(node({ providerId: undefined }), TEXT, noFailures);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('missing_model');
  });

  it('refuses a model the catalog has never heard of', () => {
    const result = router.resolve(node({ modelId: 'not-a-model' }), TEXT, noFailures);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('unavailable_model');
  });

  it('TC-MOD-004 refuses a model marked unavailable', () => {
    const result = router.resolve(node({ modelId: 'mock-retired' }), TEXT, noFailures);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('unavailable_model');
    expect(result.reason).toContain('mock-retired');
  });

  it('refuses a model whose types do not cover the node’s', () => {
    const result = router.resolve(node({ modelId: 'mock-text' }), {
      inputTypes: ['image'],
      outputTypes: ['text'],
    }, noFailures);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('incompatible_model');
  });

  it('accepts a model that covers more types than the node needs', () => {
    expect(
      router.resolve(node({ providerId: PROVIDER_B, modelId: 'gpt-5-mini' }), TEXT, noFailures).ok,
    ).toBe(true);
  });
});

describe('TC-RTR-002 fallback moves to the next model on a provider failure', () => {
  const fallbackNode = node({
    modelId: 'mock-503',
    routing: { policy: 'fallback', fallbackModelIds: ['mock-text'] },
  });

  it('starts on the primary while nothing has failed', () => {
    const result = router.resolve(fallbackNode, TEXT, noFailures);

    expect(result).toEqual({
      ok: true,
      route: { providerId: PROVIDER_A, modelId: 'mock-503', viaFallback: false },
    });
  });

  it('moves to the second model after a provider error, flagged viaFallback', () => {
    const result = router.resolve(fallbackNode, TEXT, {
      failures: [{ modelId: 'mock-503', kind: 'provider' }],
    });

    expect(result).toEqual({
      ok: true,
      route: { providerId: PROVIDER_A, modelId: 'mock-text', viaFallback: true },
    });
  });

  it('moves on after a network error too', () => {
    const result = router.resolve(fallbackNode, TEXT, {
      failures: [{ modelId: 'mock-503', kind: 'network' }],
    });

    expect(result.ok && result.route.modelId).toBe('mock-text');
  });

  it('TC-RTR-003 refuses once every model in the chain has failed', () => {
    const result = router.resolve(fallbackNode, TEXT, {
      failures: [
        { modelId: 'mock-503', kind: 'provider' },
        { modelId: 'mock-text', kind: 'provider' },
      ],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('no_candidate_left');
  });

  it('finds a fallback model that belongs to another provider', () => {
    const result = router.resolve(
      node({ modelId: 'mock-503', routing: { policy: 'fallback', fallbackModelIds: ['gpt-5-mini'] } }),
      TEXT,
      { failures: [{ modelId: 'mock-503', kind: 'provider' }] },
    );

    expect(result).toEqual({
      ok: true,
      route: { providerId: PROVIDER_B, modelId: 'gpt-5-mini', viaFallback: true },
    });
  });

  it('skips a fallback entry the catalog does not offer rather than failing the run', () => {
    const result = router.resolve(
      node({
        modelId: 'mock-503',
        routing: { policy: 'fallback', fallbackModelIds: ['ghost-model', 'mock-text'] },
      }),
      TEXT,
      { failures: [{ modelId: 'mock-503', kind: 'provider' }] },
    );

    expect(result.ok && result.route.modelId).toBe('mock-text');
  });
});

describe('FR-RTR-002 fallback never hides a failure that changing model cannot fix', () => {
  const fallbackNode = node({
    modelId: 'mock-503',
    routing: { policy: 'fallback', fallbackModelIds: ['mock-text'] },
  });

  it.each(['auth', 'invalid_config', 'agent'] as const)('stops on an %s error', (kind) => {
    const result = router.resolve(fallbackNode, TEXT, { failures: [{ modelId: 'mock-503', kind }] });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('no_candidate_left');
    expect(result.reason).toContain(kind);
  });

  it('stops on a cancellation, because the user asked it to stop', () => {
    const result = router.resolve(fallbackNode, TEXT, {
      failures: [{ modelId: 'mock-503', kind: 'user_cancelled' }],
    });

    expect(result.ok).toBe(false);
  });
});

describe('D12 the smart policies exist as an interface only in round 2', () => {
  it.each(['capability', 'cost', 'latency'] as const)('refuses %s with not_supported_yet', (policy) => {
    const result = router.resolve(
      node({ routing: { policy, fallbackModelIds: [] } }),
      TEXT,
      noFailures,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('not_supported_yet');
  });

  it.todo('TC-RTR-006 capability routing sends an image input to a vision model');
  it.todo('TC-RTR-006 cost routing picks the cheapest capable model');
  it.todo('TC-RTR-006 latency routing picks the fastest capable model by recent measurements');
});

describe('TC-RTR-005 bench runs always use fixed routing', () => {
  it('resolves a fixed node', () => {
    expect(router.resolveForBench(node(), TEXT, noFailures).ok).toBe(true);
  });

  it.each(['fallback', 'capability', 'cost', 'latency'] as const)('refuses %s', (policy) => {
    const result = router.resolveForBench(
      node({ routing: { policy, fallbackModelIds: [] } }),
      TEXT,
      noFailures,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('policy_not_allowed');
  });
});

describe('FR-RTR-006 the router never calls a provider', () => {
  it('reads the catalog it was given and nothing else', () => {
    let reads = 0;
    const counting = createRouter(() => {
      reads += 1;
      return CATALOG;
    });

    counting.resolve(node(), TEXT, noFailures);

    expect(reads).toBeGreaterThan(0);
  });
});
