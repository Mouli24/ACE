import type { Id, Model, ModelPricing } from '@ace/contracts';

import { AceNodeError, nodeErrorOf } from '../errors/index.js';
import type {
  ModelRepository,
  ModelRouter,
  ProviderAdapter,
  RouterModel,
  Scope,
  StreamChunk,
} from '../ports/index.js';
import type { ProviderService } from '../providers/index.js';

/**
 * The model gateway (X1 spec §4.1): the one place the agent runtime goes for a model.
 *
 * It answers four questions the executor, the chat service and the summariser all ask — which
 * model (the router, over the gateway's catalog), through which adapter, inside which concurrency
 * slot, at what price — and it makes every classified failure name the provider it came from.
 * Nothing above it names a provider type; nothing below it knows about runs.
 */
export interface ModelGateway {
  adapterFor(providerId: Id): Promise<ProviderAdapter>;
  runGated<T>(providerId: Id, fn: () => Promise<T>): Promise<T>;
  readonly router: ModelRouter;
  catalog(): readonly Model[];
  refreshCatalog(): Promise<void>;
  pricingFor(providerId: Id, modelId: string): ModelPricing | undefined;
}

export interface ModelGatewayDeps {
  providers: Pick<ProviderService, 'adapterFor' | 'semaphoreFor'>;
  models: Pick<ModelRepository, 'list'>;
  scope: Scope;
  /** Builds the router over a catalog reader — `createRouter` from `@ace/providers`, bound by the server. */
  createRouter: (catalog: () => readonly RouterModel[]) => ModelRouter;
}

/** A classified failure without a provider gets this one; anything else passes through as thrown. */
export function stampProvider(error: unknown, providerId: Id): unknown {
  const declared = nodeErrorOf(error);
  if (declared === undefined || declared.providerId !== undefined) return error;
  return new AceNodeError({ ...declared, providerId });
}

function normalised(adapter: ProviderAdapter, providerId: Id): ProviderAdapter {
  const embed = adapter.embed;
  return {
    type: adapter.type,
    check: () => adapter.check(),
    listModels: () => adapter.listModels(),
    ...(embed === undefined
      ? {}
      : { embed: (texts: string[], options?: { modelId?: string }) => embed.call(adapter, texts, options) }),
    generate(req, signal): AsyncIterable<StreamChunk> {
      const stream = adapter.generate(req, signal);
      return (async function* (): AsyncGenerator<StreamChunk> {
        try {
          yield* stream;
        } catch (error) {
          throw stampProvider(error, providerId);
        }
      })();
    },
  };
}

export async function createModelGateway(deps: ModelGatewayDeps): Promise<ModelGateway> {
  let cache: Model[] = [];
  const refreshCatalog = async (): Promise<void> => {
    cache = await deps.models.list(deps.scope, {});
  };
  await refreshCatalog();

  const router = deps.createRouter(() =>
    cache.map((model) => ({
      providerId: model.providerId,
      modelId: model.modelId,
      available: model.available,
      inputTypes: model.inputTypes,
      outputTypes: model.outputTypes,
      ...(model.pricing === undefined ? {} : { pricing: model.pricing }),
    })),
  );

  return {
    adapterFor: async (providerId) =>
      normalised(await deps.providers.adapterFor(providerId), providerId),
    runGated: async (providerId, fn) => (await deps.providers.semaphoreFor(providerId)).run(fn),
    router,
    catalog: () => cache,
    refreshCatalog,
    pricingFor: (providerId, modelId) =>
      cache.find((model) => model.providerId === providerId && model.modelId === modelId)
        ?.pricing,
  };
}
