import type { ModelPricing } from '@ace/contracts';
import { beforeEach, describe, expect, it } from 'vitest';

import { AceNodeError } from '../errors/index.js';
import { createEventBus } from '../events/index.js';
import { createLogger } from '../logging/index.js';
import {
  LOCAL_SCOPE,
  type EngineEvent,
  type ModelInfo,
  type ProviderAdapter,
} from '../ports/index.js';
import { createProviderService, type ProviderService } from '../providers/index.js';
import { FakeRepository } from './fake-repository.js';
import { InProcessPubSubStub } from './pubsub-stub.js';

/**
 * D286: a provider's catalog is what the provider says, and only that. A model it lists as
 * unusable stays unusable, with its reason; a provider that cannot be asked keeps what it last
 * said marked unusable, with why — the catalog never fills itself from a remembered list.
 */

const scope = LOCAL_SCOPE;
const NOW = '2026-10-09T10:00:00.000Z';

const text = (modelId: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({
  modelId,
  displayName: modelId,
  inputTypes: ['text'],
  outputTypes: ['text'],
  contextWindow: 200_000,
  supportsTools: false,
  supportsJson: false,
  ...extra,
});

let listing: () => Promise<ModelInfo[]>;
let manifest: (ModelInfo & { pricing: ModelPricing })[];
let service: ProviderService;
let repository: FakeRepository;

beforeEach(async () => {
  listing = async () => [];
  manifest = [];
  repository = new FakeRepository();
  const bus = createEventBus({
    repository,
    scope,
    pubsub: new InProcessPubSubStub<EngineEvent>(),
    now: () => NOW,
  });
  const adapter: ProviderAdapter = {
    type: 'claude_code',
    check: async () => ({ status: 'CONNECTED' }),
    listModels: () => listing(),
    // eslint-disable-next-line require-yield
    generate: async function* () {
      throw new Error('not used here');
    },
  };
  service = createProviderService({
    repository,
    scope,
    secrets: {
      isAvailable: async () => true,
      get: async () => null,
      set: async () => undefined,
      delete: async () => false,
    },
    bus,
    logger: createLogger({
      level: 'silent',
      destination: { write: () => undefined },
    }),
    now: () => NOW,
    factory: {
      create: () => adapter,
      manifestFor: () => manifest,
      mergeCatalog: (discovered, known) => [
        ...discovered.map((m) => ({ ...m, source: 'discovered' as const })),
        ...known
          .filter((m) => !discovered.some((d) => d.modelId === m.modelId))
          .map((m) => ({ ...m, source: 'manifest' as const })),
      ],
      detect: async () => ({}),
    },
  });
});

const signedOut = () =>
  new AceNodeError({
    kind: 'auth',
    code: 'cli_not_signed_in',
    message: 'Claude Code is not signed in — run `claude auth login`.',
    retryable: false,
  });

describe('D286 refreshing a catalog keeps the provider’s own word', () => {
  it('keeps each model’s availability, description and what its alias resolves to', async () => {
    listing = async () => [
      text('opus', {
        displayName: 'Opus 5.5',
        description: 'For complex work',
        resolvedModelId: 'claude-opus-5-5',
      }),
      text('claude-sonnet-5-5', {
        available: false,
        unavailableReason: 'Update Claude Code to use this model',
      }),
    ];
    const provider = await service.create({
      type: 'claude_code',
      name: 'Claude Code',
      concurrency: 1,
    });

    const { models, warning } = await service.refreshModels(provider.id);

    expect(warning).toBeUndefined();
    expect(models.find((m) => m.modelId === 'opus')).toMatchObject({
      available: true,
      displayName: 'Opus 5.5',
      description: 'For complex work',
      resolvedModelId: 'claude-opus-5-5',
    });
    expect(models.find((m) => m.modelId === 'claude-sonnet-5-5')).toMatchObject({
      available: false,
      unavailableReason: 'Update Claude Code to use this model',
    });
    expect(
      await repository.models.list(scope, {
        providerId: provider.id,
        available: true,
      }),
    ).toHaveLength(1);
  });

  it('a provider that cannot be asked keeps what it last listed, marked unusable with the reason — and adds nothing', async () => {
    listing = async () => [text('opus')];
    const provider = await service.create({
      type: 'claude_code',
      name: 'Claude Code',
      concurrency: 1,
    });
    await service.refreshModels(provider.id);

    listing = async () => {
      throw signedOut();
    };
    const { models, warning } = await service.refreshModels(provider.id);

    expect(warning).toContain('not signed in');
    expect(models.map((m) => [m.modelId, m.available, m.unavailableReason])).toEqual([
      ['opus', false, 'Claude Code is not signed in — run `claude auth login`.'],
    ]);
    expect(
      await repository.models.list(scope, {
        providerId: provider.id,
        available: true,
      }),
    ).toEqual([]);
  });

  it('a provider with a manifest falls back to it, and still says why the listing failed', async () => {
    manifest = [
      {
        ...text('gpt-x'),
        pricing: {
          inputPer1k: 0.001,
          outputPer1k: 0.002,
          priceTableVersion: 'v1',
        },
      },
    ];
    listing = async () => {
      throw new Error('connection refused');
    };
    const provider = await service.create({
      type: 'openai',
      name: 'OpenAI',
      concurrency: 1,
      apiKey: 'k',
    });

    const { models, warning } = await service.refreshModels(provider.id);

    expect(models.map((m) => [m.modelId, m.available])).toEqual([['gpt-x', true]]);
    expect(warning).toContain('connection refused');
  });
});

describe('D286 a CLI provider arrives with its models', () => {
  it('lists its models as it is added — asking a CLI costs nothing — so no Refresh is needed first', async () => {
    listing = async () => [text('default'), text('opus')];
    const provider = await service.create({
      type: 'claude_code',
      name: 'Claude Code',
      concurrency: 1,
    });

    const listed = await repository.models.list(scope, {
      providerId: provider.id,
    });
    expect(listed.map((m) => m.modelId)).toEqual(['default', 'opus']);
  });

  it('is still added when its CLI cannot list yet', async () => {
    listing = async () => {
      throw signedOut();
    };
    const provider = await service.create({
      type: 'claude_code',
      name: 'Claude Code',
      concurrency: 1,
    });

    expect(await service.get(provider.id)).not.toBeNull();
    expect(await repository.models.list(scope, { providerId: provider.id })).toEqual([]);
  });
});
