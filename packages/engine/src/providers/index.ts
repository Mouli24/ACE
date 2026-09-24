import {
  type CreateProviderRequest,
  type Id,
  type Model,
  type ModelQuery,
  type Provider,
  type ProviderCheckResult,
  type ProviderDetectResponse,
  type UpdateProviderRequest,
} from '@ace/contracts';

import type { EventBus } from '../events/index.js';
import { newId } from '../ids.js';
import type { Logger } from '../logging/index.js';
import type {
  ModelInfo,
  ProviderAdapter,
  ProviderAdapterFactory,
  Repository,
  Scope,
  SecretStore,
} from '../ports/index.js';
import { createSemaphore, type Semaphore } from './semaphore.js';

export * from './semaphore.js';

/**
 * The provider service (FR-PRV-001..010, Arch §12.2).
 *
 * The rule that shapes it: a key is written to the `SecretStore` and read back nowhere except
 * when building an adapter. `keySet` is *derived* from the store on every read, so a provider
 * whose key was removed behind the engine's back reports the truth rather than a stale flag
 * (FR-PRV-002, BR-07).
 */

/** How often the engine re-checks every provider (FR-PRV-004). */
export const PROVIDER_CHECK_INTERVAL_MS = 60_000;

/** Where a provider's key lives in the keychain. */
export function providerSecretKey(providerId: Id): string {
  return `provider:${providerId}:apiKey`;
}

export type RemoveProviderResult =
  | { ok: true }
  | { ok: false; reason: 'in_use'; nodeIds: Id[] };

export interface ProviderService {
  create(input: CreateProviderRequest): Promise<Provider>;
  list(): Promise<Provider[]>;
  get(id: Id): Promise<Provider | null>;
  update(id: Id, patch: UpdateProviderRequest): Promise<Provider | null>;
  remove(id: Id, options: { confirm: boolean }): Promise<RemoveProviderResult>;

  /** FR-PRV-003: ask the provider, store the verdict, tell everyone (FR-PRV-004). */
  check(id: Id): Promise<ProviderCheckResult>;
  checkAll(): Promise<void>;
  /** Starts the 60 s timer; the returned function stops it. */
  startPeriodicChecks(): () => void;

  refreshModels(id: Id): Promise<{ models: Model[]; refreshedAt: string }>;
  listModels(query: ModelQuery): Promise<Model[]>;
  detect(): Promise<ProviderDetectResponse>;

  /** The live adapter for a stored provider — built fresh so a rotated key takes effect. */
  adapterFor(id: Id): Promise<ProviderAdapter>;
  /** The one concurrency gate for this provider (FR-PRV-009). */
  semaphoreFor(id: Id): Promise<Semaphore>;
}

export interface ProviderServiceDeps {
  repository: Repository;
  scope: Scope;
  secrets: SecretStore;
  factory: ProviderAdapterFactory;
  bus: EventBus;
  logger: Logger;
  now?: () => string;
  nextId?: () => string;
}

export class ProviderNotFoundError extends Error {
  override readonly name = 'ProviderNotFoundError';

  constructor(id: Id) {
    super(`Provider ${id} was not found.`);
  }
}

export function createProviderService(deps: ProviderServiceDeps): ProviderService {
  const { repository, scope, secrets, factory, bus, logger } = deps;
  const now = deps.now ?? (() => new Date().toISOString());
  const nextId = deps.nextId ?? newId;

  /**
   * One gate per provider, kept alive across calls so the limit actually limits. The lookup is
   * cached, not the gate it resolves to: nodes dispatched together all ask before the first lookup
   * finishes, and caching only the result let each of them build its own gate (D-027).
   */
  const gates = new Map<Id, Promise<Semaphore>>();

  /** `keySet` is never trusted from the row; it is what the keychain says right now. */
  async function withKeySet(provider: Provider): Promise<Provider> {
    const key = await secrets.get(scope, providerSecretKey(provider.id));
    return { ...provider, keySet: key !== null };
  }

  async function load(id: Id): Promise<Provider> {
    const provider = await repository.providers.get(scope, id);
    if (provider === null) throw new ProviderNotFoundError(id);
    return withKeySet(provider);
  }

  async function announce(provider: Provider, result: ProviderCheckResult): Promise<void> {
    // Engine scope: no workflowId, so every client watching the engine sees it (§2.4).
    await bus.emit({
      type: 'provider.status',
      payload: {
        providerId: provider.id,
        status: result.status,
        ...(result.message === undefined ? {} : { message: result.message }),
      },
    });
  }

  const service: ProviderService = {
    async create(input) {
      const timestamp = now();
      const id = nextId();

      if (input.apiKey !== undefined && input.apiKey !== '') {
        await secrets.set(scope, providerSecretKey(id), input.apiKey);
      }

      const provider: Provider = {
        id,
        type: input.type,
        name: input.name,
        ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
        keySet: input.apiKey !== undefined && input.apiKey !== '',
        // A provider is UNKNOWN until something has actually asked it (Arch §19.3).
        status: 'UNKNOWN',
        concurrency: input.concurrency,
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      await repository.providers.create(scope, provider);
      logger.info({ subsystem: 'providers', providerId: id, type: input.type }, 'provider added');
      return provider;
    },

    async list() {
      const rows = await repository.providers.list(scope);
      return Promise.all(rows.map(withKeySet));
    },

    async get(id) {
      const provider = await repository.providers.get(scope, id);
      return provider === null ? null : withKeySet(provider);
    },

    async update(id, patch) {
      const existing = await repository.providers.get(scope, id);
      if (existing === null) return null;

      // An `apiKey` in the patch means rotate (§2.1); its absence means leave the key alone.
      if (patch.apiKey !== undefined && patch.apiKey !== '') {
        await secrets.set(scope, providerSecretKey(id), patch.apiKey);
      }

      const updated = await repository.providers.update(scope, id, {
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.baseUrl === undefined ? {} : { baseUrl: patch.baseUrl }),
        ...(patch.concurrency === undefined ? {} : { concurrency: patch.concurrency }),
        ...(patch.apiKey === undefined ? {} : { keySet: true }),
        updatedAt: now(),
      });

      // The gate is sized from the row, so a changed limit has to drop the old one.
      if (patch.concurrency !== undefined) gates.delete(id);

      return updated === null ? null : withKeySet(updated);
    },

    async remove(id, options) {
      const nodes = await repository.nodes.listByProvider(scope, id);

      if (nodes.length > 0 && !options.confirm) {
        return { ok: false, reason: 'in_use', nodeIds: nodes.map((node) => node.id) };
      }

      // The nodes are deliberately left pointing at a provider that is gone: `validate` reports
      // `provider_missing` on each of them, which is what FR-PRV-005 asks the user to see.
      await repository.models.deleteForProvider(scope, id);
      await secrets.delete(scope, providerSecretKey(id));
      await repository.providers.delete(scope, id);
      gates.delete(id);

      logger.info({ subsystem: 'providers', providerId: id, nodes: nodes.length }, 'provider removed');
      return { ok: true };
    },

    async check(id) {
      const provider = await load(id);
      const adapter = await service.adapterFor(id);
      const status = await adapter.check();
      const checkedAt = now();

      await repository.providers.update(scope, id, {
        status: status.status,
        statusMessage: status.message ?? null,
        lastCheckedAt: checkedAt,
        updatedAt: checkedAt,
      });

      const result: ProviderCheckResult = {
        status: status.status,
        ...(status.message === undefined ? {} : { message: status.message }),
        ...(status.latencyMs === undefined ? {} : { latencyMs: status.latencyMs }),
        checkedAt,
      };

      await announce(provider, result);
      return result;
    },

    async checkAll() {
      for (const provider of await repository.providers.list(scope)) {
        try {
          await service.check(provider.id);
        } catch (error) {
          // One unreachable provider must not stop the sweep over the others.
          logger.warn(
            { subsystem: 'providers', providerId: provider.id, err: error },
            'scheduled provider check failed',
          );
        }
      }
    },

    startPeriodicChecks() {
      const timer = setInterval(() => {
        void service.checkAll();
      }, PROVIDER_CHECK_INTERVAL_MS);
      // Nothing should be kept alive by a health check.
      timer.unref?.();

      return () => clearInterval(timer);
    },

    async refreshModels(id) {
      const provider = await load(id);
      const adapter = await service.adapterFor(id);

      let discovered: ModelInfo[] = [];
      try {
        discovered = await adapter.listModels();
      } catch (error) {
        // A provider that cannot list is exactly what the manifest exists for (FR-MOD-002).
        logger.warn(
          { subsystem: 'providers', providerId: id, err: error },
          'model discovery failed; falling back to the manifest',
        );
      }

      const merged = factory.mergeCatalog(discovered, factory.manifestFor(provider.type));
      const refreshedAt = now();

      // Row ids are stable across refreshes, so a node that names a model keeps working.
      const existing = await repository.models.list(scope, { providerId: id });
      const idByModelId = new Map(existing.map((model) => [model.modelId, model.id]));

      const models: Model[] = merged.map((model) => ({
        id: idByModelId.get(model.modelId) ?? nextId(),
        providerId: id,
        modelId: model.modelId,
        displayName: model.displayName,
        inputTypes: model.inputTypes,
        outputTypes: model.outputTypes,
        contextWindow: model.contextWindow,
        supportsTools: model.supportsTools,
        supportsJson: model.supportsJson,
        available: true,
        source: model.source,
        lastCheckedAt: refreshedAt,
        ...(model.pricing === undefined ? {} : { pricing: model.pricing }),
      }));

      await repository.models.replaceForProvider(scope, id, models);
      await freezePriceTables(models, refreshedAt);

      return { models, refreshedAt };
    },

    listModels: (query) => repository.models.list(scope, query),

    detect: () => factory.detect(),

    async adapterFor(id) {
      const provider = await load(id);
      const apiKey = await secrets.get(scope, providerSecretKey(id));
      return factory.create(provider, apiKey ?? undefined);
    },

    async semaphoreFor(id) {
      const existing = gates.get(id);
      if (existing !== undefined) return existing;

      const gate = load(id).then((provider) => createSemaphore(provider.concurrency));
      gates.set(id, gate);
      // A failed lookup (say, a provider removed mid-dispatch) must not stay cached.
      gate.catch(() => {
        if (gates.get(id) === gate) gates.delete(id);
      });
      return gate;
    },
  };

  /**
   * Write the price table each model quoted, once per version (FR-OBS-003). The store ignores a
   * version it already has, so an old run's estimate can always be recomputed from the table
   * that was in force when it ran.
   */
  async function freezePriceTables(models: readonly Model[], at: string): Promise<void> {
    const byVersion = new Map<string, Record<string, { inputPer1k: number; outputPer1k: number }>>();

    for (const model of models) {
      if (model.pricing === undefined) continue;
      const table = byVersion.get(model.pricing.priceTableVersion) ?? {};
      table[model.modelId] = {
        inputPer1k: model.pricing.inputPer1k,
        outputPer1k: model.pricing.outputPer1k,
      };
      byVersion.set(model.pricing.priceTableVersion, table);
    }

    for (const [version, data] of byVersion) {
      await repository.priceTables.put(scope, { version, data, createdAt: at });
    }
  }

  return service;
}
