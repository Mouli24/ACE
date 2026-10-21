import {
  CreateProviderRequestSchema,
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_CLI_PERMISSION,
  isCliProviderType,
  type LocalModelActionResponse,
  type LocalRunningModel,
  type LocalRuntimeStatus,
  type PullModelAccepted,
  type TryModelResponse,
  type CliDetectResponse,
  type CreateProviderRequest,
  type Id,
  type Model,
  type ModelCapabilitiesPatch,
  type ModelQuery,
  type Provider,
  type ProviderCheckResult,
  type ProviderDetectResponse,
  type ProviderState,
  type UpdateProviderRequest,
} from "@ace/contracts";

import { classifyError } from "../errors/index.js";
import type { EventBus } from "../events/index.js";
import { newId } from "../ids.js";
import type { Logger } from "../logging/index.js";
import type {
  LocalModelControl,
  LocalRuntimeProbe,
  ModelInfo,
  ProviderAdapter,
  ProviderAdapterFactory,
  Repository,
  Scope,
  SecretStore,
} from "../ports/index.js";
import { maskSecrets } from "../security/secret-patterns.js";
import { createSemaphore, type Semaphore } from "./semaphore.js";

export * from "./semaphore.js";

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
  | {
      ok: false;
      reason: "in_use";
      nodeIds: Id[];
      /** The names of the knowledge bases that embed with the provider, when any do. */
      knowledgeBases?: string[];
    };

export interface ProviderService {
  create(input: CreateProviderRequest): Promise<Provider>;
  list(): Promise<Provider[]>;
  get(id: Id): Promise<Provider | null>;
  update(id: Id, patch: UpdateProviderRequest): Promise<Provider | null>;
  remove(id: Id, options: { confirm: boolean }): Promise<RemoveProviderResult>;

  /** FR-PRV-003: ask the provider, store the verdict, tell everyone (FR-PRV-004). */
  check(id: Id): Promise<ProviderCheckResult>;
  /**
   * Store what the engine has learnt about a provider without asking it, and tell everyone — what a
   * failed call proved: a key refused mid-run marks the provider AUTH_FAILED (Arch §28, §19.3).
   * `check` stores its verdict the same way, so there is one writer of provider state. A provider
   * removed meanwhile is left alone.
   */
  recordStatus(
    id: Id,
    found: { status: ProviderState; message?: string },
  ): Promise<void>;
  checkAll(): Promise<void>;
  /** Starts the 60 s timer; the returned function stops it. */
  startPeriodicChecks(): () => void;

  /**
   * FR-MOD-006, D286: ask the provider for its models. When it cannot be asked, `warning` says why;
   * the models it last listed are then kept, marked unavailable — never replaced by a guess.
   */
  refreshModels(
    id: Id,
  ): Promise<{ models: Model[]; refreshedAt: string; warning?: string }>;
  listModels(query: ModelQuery): Promise<Model[]>;
  /**
   * D380: record what the person says a model can do. The updated model, or null when the provider
   * lists no such model. A refresh keeps it.
   */
  setModelCapabilities(
    id: Id,
    modelId: string,
    patch: ModelCapabilitiesPatch,
  ): Promise<Model | null>;
  detect(): Promise<ProviderDetectResponse>;
  /** X1 (FR-PRV-008): the terminal scan — installed, version and sign-in per CLI. */
  detectClis?(): Promise<CliDetectResponse>;

  /** The live adapter for a stored provider — built fresh so a rotated key takes effect. */
  adapterFor(id: Id): Promise<ProviderAdapter>;
  /** The one concurrency gate for this provider (FR-PRV-009). */
  semaphoreFor(id: Id): Promise<Semaphore>;

  /* PG-1.4 (D359): models on this machine, without a terminal. */

  /** `GET /local-runtime`: installed, answering, started by the engine. Never starts anything. */
  localRuntime?(): Promise<LocalRuntimeStatus>;
  /**
   * Start Ollama when it is installed and not answering, then add an `ollama` provider when there
   * is none (never a second one) and refresh its models.
   */
  ensureLocalRuntime?(): Promise<LocalRuntimeStatus>;
  /** Stop the Ollama server this engine started; one the person started is left alone. */
  stopLocalRuntime?(): Promise<void>;
  runningLocalModels?(id: Id): Promise<LocalRunningModel[]>;
  loadLocalModel?(id: Id, modelId: string): Promise<LocalModelActionResponse>;
  unloadLocalModel?(id: Id, modelId: string): Promise<LocalModelActionResponse>;
  /** Starts the pull and answers at once; progress rides `model.pull`, then the models refresh. */
  pullLocalModel?(id: Id, name: string): Promise<PullModelAccepted>;
  /** "Try this model": one non-streaming call, no tools, secrets masked both ways. */
  tryModel?(id: Id, modelId: string, prompt: string): Promise<TryModelResponse>;
}

/** How long "Try this model" waits for its answer. */
export const TRY_MODEL_TIMEOUT_MS = 60_000;
/** The most a try may write: a sentence or a paragraph, not an essay on the person's bill. */
export const TRY_MODEL_MAX_TOKENS = 512;

export interface ProviderServiceDeps {
  repository: Repository;
  scope: Scope;
  secrets: SecretStore;
  factory: ProviderAdapterFactory;
  bus: EventBus;
  logger: Logger;
  now?: () => string;
  nextId?: () => string;
  /**
   * PG-1.4 (D359): start the local Ollama and add its provider without being asked — on
   * `GET /providers/detect` and when the engine starts. Off unless the engine is the product
   * (`ace-engine`); a test engine never starts anything on the machine it runs on.
   */
  autoLocalRuntime?: boolean;
}

/** A local-model action asked of a provider that is not Ollama, or with no runtime wired. */
export class LocalModelRefusedError extends Error {
  override readonly name = "LocalModelRefusedError";
}

/** A local-model or try call the provider failed; `message` is safe to show (masked). */
export class ProviderActionError extends Error {
  override readonly name = "ProviderActionError";
}

export class ProviderNotFoundError extends Error {
  override readonly name = "ProviderNotFoundError";

  constructor(id: Id) {
    super(`Provider ${id} was not found.`);
  }
}

export function createProviderService(
  deps: ProviderServiceDeps,
): Required<ProviderService> {
  const { repository, scope, secrets, factory, bus, logger } = deps;
  const now = deps.now ?? (() => new Date().toISOString());
  const nextId = deps.nextId ?? newId;

  /**
   * One gate per provider, kept alive across calls so the limit actually limits. The lookup is
   * cached, not the gate it resolves to: nodes dispatched together all ask before the first lookup
   * finishes, and caching only the result let each of them build its own gate (D-027).
   */
  const gates = new Map<Id, Promise<Semaphore>>();

  const local: LocalModelControl | undefined = factory.local;
  const autoLocal = deps.autoLocalRuntime === true;
  /** One add at a time, so two callers never create two Ollama providers. */
  let addingLocal: Promise<Provider | undefined> | undefined;
  /** Pulls in flight, by provider and name, so a second click does not start a second one. */
  const pulls = new Set<string>();

  // An Ollama row may hold its OpenAI endpoint, `…/v1`: the same server [audit P-4].
  const hostOf = (url: string): string =>
    url.replace(/\/+$/, "").replace(/\/v1$/i, "").toLowerCase();
  const sameUrl = (a: string, b: string): boolean => hostOf(a) === hostOf(b);

  async function toStatus(probe: LocalRuntimeProbe): Promise<LocalRuntimeStatus> {
    const rows = await repository.providers.list(scope);
    const provider =
      rows.find(
        (row) =>
          row.type === "ollama" &&
          row.baseUrl !== undefined &&
          sameUrl(row.baseUrl, probe.baseUrl),
      ) ?? rows.find((row) => row.type === "ollama");
    return {
      installed: probe.installed,
      running: probe.running,
      startedByAce: probe.startedByAce,
      baseUrl: probe.baseUrl,
      ...(probe.binaryPath === undefined ? {} : { binaryPath: probe.binaryPath }),
      ...(probe.version === undefined ? {} : { version: probe.version }),
      ...(provider === undefined ? {} : { providerId: provider.id }),
      ...(probe.error === undefined ? {} : { error: maskSecrets(probe.error) }),
    };
  }

  /** Add the `ollama` provider for a running runtime, unless one exists. Never a duplicate. */
  function addLocalIfMissing(probe: LocalRuntimeProbe): Promise<Provider | undefined> {
    addingLocal ??= (async () => {
      if (!probe.running) return undefined;
      const existing = (await repository.providers.list(scope)).find(
        (row) => row.type === "ollama",
      );
      if (existing !== undefined) return existing;
      const created = await service.create(
        CreateProviderRequestSchema.parse({
          type: "ollama",
          name: "Ollama",
          baseUrl: probe.baseUrl,
        }),
      );
      logger.info(
        { subsystem: "providers", providerId: created.id },
        "added the local Ollama found on this machine",
      );
      // CONNECTED, and its models listed (check fills an empty catalogue).
      try {
        await service.check(created.id);
      } catch (error) {
        logger.warn(
          { subsystem: "providers", providerId: created.id, err: error },
          "the new Ollama provider could not be checked",
        );
      }
      return created;
    })().finally(() => {
      addingLocal = undefined;
    });
    return addingLocal;
  }

  /** The Ollama provider row, refused (400) for any other type or with no runtime wired. */
  async function loadOllama(
    id: Id,
  ): Promise<{ provider: Provider; control: LocalModelControl; url: string }> {
    const provider = await load(id);
    if (provider.type !== "ollama") {
      throw new LocalModelRefusedError(
        `Models on this machine are managed for Ollama providers only; "${provider.name}" is ${provider.type}.`,
      );
    }
    if (local === undefined) {
      throw new LocalModelRefusedError("This engine cannot manage local models.");
    }
    const url = provider.baseUrl ?? (await local.status()).baseUrl;
    return { provider, control: local, url };
  }

  /** Start the runtime when this provider is the local one and it is not answering. */
  async function ensureFor(provider: Provider, control: LocalModelControl): Promise<boolean> {
    const before = await control.status();
    const url = provider.baseUrl ?? before.baseUrl;
    if (before.running || !sameUrl(url, before.baseUrl)) return false;
    const after = await control.ensureRunning();
    if (!after.running) {
      throw new ProviderActionError(
        after.installed
          ? maskSecrets(after.error ?? "Ollama could not be started.")
          : "Ollama is not installed on this computer.",
      );
    }
    return true;
  }

  function actionError(error: unknown, id: Id): ProviderActionError {
    if (error instanceof ProviderActionError) return error;
    return new ProviderActionError(
      maskSecrets(classifyError(error, { providerId: id }).message),
    );
  }

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

  /**
   * The one place a provider's state is written: stored, then announced (FR-PRV-003, FR-PRV-004).
   * A provider that is gone has nothing to store and nothing to tell anyone.
   */
  async function storeStatus(
    id: Id,
    found: { status: ProviderState; message?: string },
    at: string,
  ): Promise<void> {
    const updated = await repository.providers.update(scope, id, {
      status: found.status,
      statusMessage: found.message ?? null,
      lastCheckedAt: at,
      updatedAt: at,
    });
    if (updated === null) return;

    // Engine scope: no workflowId, so every client watching the engine sees it (§2.4).
    await bus.emit({
      type: "provider.status",
      payload: {
        providerId: id,
        status: found.status,
        ...(found.message === undefined ? {} : { message: found.message }),
      },
    });
  }

  const service: Required<ProviderService> = {
    async create(input) {
      const timestamp = now();
      const id = nextId();

      if (input.apiKey !== undefined && input.apiKey !== "") {
        await secrets.set(scope, providerSecretKey(id), input.apiKey);
      }

      const provider: Provider = {
        id,
        type: input.type,
        name: input.name,
        ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
        keySet: input.apiKey !== undefined && input.apiKey !== "",
        // A provider is UNKNOWN until something has actually asked it (Arch §19.3).
        status: "UNKNOWN",
        concurrency: input.concurrency,
        ...(isCliProviderType(input.type)
          ? { cliPermission: input.cliPermission ?? DEFAULT_CLI_PERMISSION }
          : {}),
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      await repository.providers.create(scope, provider);
      logger.info(
        { subsystem: "providers", providerId: id, type: input.type },
        "provider added",
      );

      /*
       * D286: a CLI provider lists its models by asking the installed CLI, which costs no tokens,
       * so it arrives with them — an empty catalog until someone presses Refresh left every node
       * on it unrunnable. Best effort: a CLI that cannot list yet still gets added.
       */
      if (isCliProviderType(input.type)) {
        try {
          await service.refreshModels(id);
        } catch (error) {
          logger.warn(
            { subsystem: "providers", providerId: id, err: error },
            "the new CLI provider could not list its models yet",
          );
        }
      }
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
      if (patch.apiKey !== undefined && patch.apiKey !== "") {
        await secrets.set(scope, providerSecretKey(id), patch.apiKey);
      }

      const updated = await repository.providers.update(scope, id, {
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.baseUrl === undefined ? {} : { baseUrl: patch.baseUrl }),
        ...(patch.concurrency === undefined
          ? {}
          : { concurrency: patch.concurrency }),
        ...(patch.cliPermission === undefined
          ? {}
          : { cliPermission: patch.cliPermission }),
        ...(patch.apiKey === undefined ? {} : { keySet: true }),
        updatedAt: now(),
      });

      // The gate is sized from the row, so a changed limit has to drop the old one.
      if (patch.concurrency !== undefined) gates.delete(id);

      return updated === null ? null : withKeySet(updated);
    },

    async remove(id, options) {
      const nodes = await repository.nodes.listByProvider(scope, id);
      // A base embeds with its provider for good — the field cannot be changed — so a base counts
      // as a use, and so do the agent and Retrieval nodes reading it (final-review I5).
      const bases =
        (await repository.knowledgeBases?.listByEmbeddingProvider(scope, id)) ??
        [];
      const attached = await Promise.all(
        bases.map((kb) => repository.nodes.listByKnowledgeBase(scope, kb.id)),
      );
      const nodeIds = [
        ...new Set([...nodes, ...attached.flat()].map((node) => node.id)),
      ].sort();

      if ((nodeIds.length > 0 || bases.length > 0) && !options.confirm) {
        return {
          ok: false,
          reason: "in_use",
          nodeIds,
          ...(bases.length === 0
            ? {}
            : { knowledgeBases: bases.map((kb) => kb.name) }),
        };
      }

      // The nodes are deliberately left pointing at a provider that is gone: `validate` reports
      // `provider_missing` on each of them, which is what FR-PRV-005 asks the user to see.
      await repository.models.deleteForProvider(scope, id);
      await secrets.delete(scope, providerSecretKey(id));
      await repository.providers.delete(scope, id);
      gates.delete(id);

      logger.info(
        {
          subsystem: "providers",
          providerId: id,
          nodes: nodeIds.length,
          knowledgeBases: bases.length,
        },
        "provider removed",
      );
      return { ok: true };
    },

    async check(id) {
      await load(id);
      const adapter = await service.adapterFor(id);
      const status = await adapter.check();
      const checkedAt = now();

      await storeStatus(
        id,
        {
          status: status.status,
          ...(status.message === undefined ? {} : { message: status.message }),
        },
        checkedAt,
      );

      /*
       * FR-MOD-001: a provider that answers lists its models without anyone pressing Refresh. Only
       * an empty catalog is filled here — once filled, Refresh is what asks again. Best effort: a
       * listing that fails leaves the check's answer as it is.
       */
      if (
        status.status === "CONNECTED" &&
        (await repository.models.list(scope, { providerId: id })).length === 0
      ) {
        try {
          await service.refreshModels(id);
        } catch (error) {
          logger.warn(
            { subsystem: "providers", providerId: id, err: error },
            "the connected provider could not list its models yet",
          );
        }
      }

      return {
        status: status.status,
        ...(status.message === undefined ? {} : { message: status.message }),
        ...(status.latencyMs === undefined
          ? {}
          : { latencyMs: status.latencyMs }),
        checkedAt,
      };
    },

    recordStatus: (id, found) => storeStatus(id, found, now()),

    async checkAll() {
      for (const provider of await repository.providers.list(scope)) {
        try {
          await service.check(provider.id);
        } catch (error) {
          // One unreachable provider must not stop the sweep over the others.
          logger.warn(
            { subsystem: "providers", providerId: provider.id, err: error },
            "scheduled provider check failed",
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
      let warning: string | undefined;
      try {
        discovered = await adapter.listModels();
      } catch (error) {
        // The reason is reported, never swallowed (D286).
        warning = maskSecrets(classifyError(error, { providerId: id }).message);
        logger.warn(
          { subsystem: "providers", providerId: id, err: error },
          "model discovery failed",
        );
      }

      const manifest = factory.manifestFor(provider.type);
      const refreshedAt = now();

      // Row ids are stable across refreshes, so a node that names a model keeps working.
      const existing = await repository.models.list(scope, { providerId: id });
      const idByModelId = new Map(
        existing.map((model) => [model.modelId, model.id]),
      );

      /*
       * D286: the models it last listed stay, each marked unavailable with the reason. A node
       * naming one is refused with that reason rather than the model vanishing, and no model is
       * ever offered that nothing vouched for. [audit P-5] This holds for a provider with a
       * manifest too: swapping a listed catalogue for the manifest dropped what the key really
       * offers, and what the person set on those models (D380). Only a catalogue the provider never
       * listed — empty, or the manifest itself — falls back to the manifest (FR-MOD-002); a CLI
       * has none, so it keeps what it has.
       */
      const listedBefore = existing.some((model) => model.source === "discovered");
      if (warning !== undefined && (listedBefore || manifest.length === 0)) {
        const models: Model[] = existing.map((model) => ({
          ...model,
          available: false,
          unavailableReason: warning,
          lastCheckedAt: refreshedAt,
        }));
        await repository.models.replaceForProvider(scope, id, models);
        return { models, refreshedAt, warning };
      }

      const merged = factory.mergeCatalog(discovered, manifest);
      const models: Model[] = merged.map((model) => {
        const available = model.available ?? true;
        return {
          id: idByModelId.get(model.modelId) ?? nextId(),
          providerId: id,
          modelId: model.modelId,
          displayName: model.displayName,
          inputTypes: model.inputTypes,
          outputTypes: model.outputTypes,
          contextWindow: model.contextWindow,
          supportsTools: model.supportsTools,
          supportsJson: model.supportsJson,
          available,
          source: model.source,
          lastCheckedAt: refreshedAt,
          ...(model.pricing === undefined ? {} : { pricing: model.pricing }),
          ...(model.description === undefined
            ? {}
            : { description: model.description }),
          ...(model.resolvedModelId === undefined
            ? {}
            : { resolvedModelId: model.resolvedModelId }),
          ...(model.sizeBytes === undefined ? {} : { sizeBytes: model.sizeBytes }),
          ...(available || model.unavailableReason === undefined
            ? {}
            : { unavailableReason: model.unavailableReason }),
        };
      });

      await repository.models.replaceForProvider(scope, id, models);
      await freezePriceTables(models, refreshedAt);

      return {
        // D380: what the person set on a model is applied by the read, not by this merge.
        models: await repository.models.list(scope, { providerId: id }),
        refreshedAt,
        ...(warning === undefined ? {} : { warning }),
      };
    },

    listModels: (query) => repository.models.list(scope, query),

    setModelCapabilities: async (id, modelId, patch) => {
      return repository.models.setCapabilities(scope, id, modelId, patch);
    },

    async detect() {
      const found = await factory.detect();
      // PG-1.4 (D359): an Ollama that answers is added; one installed but stopped is started, in
      // the background — detection must never hold the UI up.
      if (autoLocal && local !== undefined) {
        if (found.ollama?.detected === true) {
          try {
            await addLocalIfMissing(await local.status());
          } catch (error) {
            logger.warn(
              { subsystem: "providers", err: error },
              "could not add the local Ollama",
            );
          }
        } else {
          void service.ensureLocalRuntime().catch((error: unknown) => {
            logger.warn(
              { subsystem: "providers", err: error },
              "could not start the local Ollama",
            );
          });
        }
      }
      return found;
    },

    detectClis: async () => (await factory.detectClis?.()) ?? { items: [] },

    async adapterFor(id) {
      const provider = await load(id);
      const apiKey = await secrets.get(scope, providerSecretKey(id));
      return factory.create(provider, apiKey ?? undefined);
    },

    async semaphoreFor(id) {
      const existing = gates.get(id);
      if (existing !== undefined) return existing;

      const gate = load(id).then((provider) =>
        createSemaphore(provider.concurrency),
      );
      gates.set(id, gate);
      // A failed lookup (say, a provider removed mid-dispatch) must not stay cached.
      gate.catch(() => {
        if (gates.get(id) === gate) gates.delete(id);
      });
      return gate;
    },

    async localRuntime() {
      if (local === undefined) {
        return {
          installed: false,
          running: false,
          startedByAce: false,
          baseUrl: DEFAULT_OLLAMA_BASE_URL,
        };
      }
      return toStatus(await local.status());
    },

    async ensureLocalRuntime() {
      if (local === undefined) return service.localRuntime();
      const probe = await local.ensureRunning();
      if (probe.running) {
        const existing = (await repository.providers.list(scope)).find(
          (row) => row.type === "ollama",
        );
        if (existing === undefined) {
          await addLocalIfMissing(probe);
        } else {
          // A catalogue stored by an older engine lacks sizes and capabilities (D-100): ask again.
          try {
            await service.check(existing.id);
            await service.refreshModels(existing.id);
          } catch (error) {
            logger.warn(
              { subsystem: "providers", providerId: existing.id, err: error },
              "the local Ollama could not list its models",
            );
          }
        }
      }
      return toStatus(probe);
    },

    async stopLocalRuntime() {
      await local?.stopOwned();
    },

    async runningLocalModels(id) {
      const { control, url } = await loadOllama(id);
      try {
        const items = await control.running(url);
        return items.map((item) => ({
          modelId: item.modelId,
          ...(item.sizeBytes === undefined ? {} : { sizeBytes: item.sizeBytes }),
          ...(item.sizeVramBytes === undefined
            ? {}
            : { sizeVramBytes: item.sizeVramBytes }),
          ...(item.expiresAt === undefined ? {} : { expiresAt: item.expiresAt }),
        }));
      } catch (error) {
        // A server that is not running has nothing loaded: an empty list, not a failure.
        if (!(await control.status()).running) return [];
        throw actionError(error, id);
      }
    },

    async loadLocalModel(id, modelId) {
      const { provider, control, url } = await loadOllama(id);
      const startedRuntime = await ensureFor(provider, control);
      try {
        await control.load(url, modelId);
      } catch (error) {
        throw actionError(error, id);
      }
      logger.info(
        { subsystem: "providers", providerId: id, modelId },
        "loaded a local model",
      );
      return { modelId, loaded: true, ...(startedRuntime ? { startedRuntime } : {}) };
    },

    async unloadLocalModel(id, modelId) {
      const { control, url } = await loadOllama(id);
      try {
        await control.unload(url, modelId);
      } catch (error) {
        // Nothing to unload from a server that is not running.
        if (!(await control.status()).running) return { modelId, loaded: false };
        throw actionError(error, id);
      }
      return { modelId, loaded: false };
    },

    async pullLocalModel(id, name) {
      const { provider, control, url } = await loadOllama(id);
      await ensureFor(provider, control);
      const key = `${id} ${name}`;
      if (pulls.has(key)) return { providerId: id, name, accepted: true };
      pulls.add(key);

      const emit = (progress: {
        status: string;
        completed?: number;
        total?: number;
        done: boolean;
        error?: string;
      }): void => {
        bus
          .emitTransient({
            type: "model.pull",
            payload: { providerId: id, name, ...progress },
          })
          .catch(() => undefined);
      };
      emit({ status: "starting", done: false });

      // Ollama sends a line per chunk; a frame every ~250 ms is plenty for a progress bar.
      let lastSent = 0;
      void control
        .pull(url, name, (progress) => {
          const at = Date.now();
          if (at - lastSent < 250) return;
          lastSent = at;
          emit({
            status: progress.status,
            ...(progress.completed === undefined ? {} : { completed: progress.completed }),
            ...(progress.total === undefined ? {} : { total: progress.total }),
            done: false,
          });
        })
        .then(async () => {
          try {
            await service.refreshModels(id);
          } catch (error) {
            logger.warn(
              { subsystem: "providers", providerId: id, err: error },
              "pulled a model but could not refresh the catalogue",
            );
          }
          logger.info(
            { subsystem: "providers", providerId: id, name },
            "pulled a local model",
          );
          emit({ status: "success", done: true });
        })
        .catch((error: unknown) => {
          const message = maskSecrets(
            error instanceof Error ? error.message : String(error),
          );
          logger.warn(
            { subsystem: "providers", providerId: id, name, reason: message },
            "a model pull failed",
          );
          emit({ status: "failed", done: true, error: message });
        })
        .finally(() => pulls.delete(key));

      return { providerId: id, name, accepted: true };
    },

    async tryModel(id, modelId, prompt) {
      const provider = await load(id);
      if (provider.type === "ollama" && local !== undefined) {
        await ensureFor(provider, local);
      }
      const adapter = await service.adapterFor(id);
      const gate = await service.semaphoreFor(id);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TRY_MODEL_TIMEOUT_MS);
      const startedAt = Date.now();
      const sent = maskSecrets(prompt);
      let text = "";
      let usage:
        | { tokensIn: number; tokensOut: number; costUsd?: number }
        | undefined;
      try {
        await gate.run(async () => {
          for await (const chunk of adapter.generate(
            {
              modelId,
              prompt: sent,
              outputTypes: ["text"],
              maxTokens: TRY_MODEL_MAX_TOKENS,
            },
            controller.signal,
          )) {
            if (chunk.type === "text") text += chunk.delta;
            else if (chunk.type === "json") text += JSON.stringify(chunk.value);
            else if (chunk.type === "usage") {
              usage = {
                tokensIn: chunk.tokensIn,
                tokensOut: chunk.tokensOut,
                ...(chunk.costUsd === undefined ? {} : { costUsd: chunk.costUsd }),
              };
            }
          }
        });
      } catch (error) {
        if (controller.signal.aborted) {
          throw new ProviderActionError(
            `The model did not answer within ${TRY_MODEL_TIMEOUT_MS / 1000} s.`,
          );
        }
        throw actionError(error, id);
      } finally {
        clearTimeout(timer);
      }

      // No usage reported: estimated as the executor does, about 4 characters a token.
      const tokensIn = usage?.tokensIn ?? Math.ceil(sent.length / 4);
      const tokensOut = usage?.tokensOut ?? Math.ceil(text.length / 4);
      let costUsd = usage?.costUsd;
      if (costUsd === undefined) {
        const model = (
          await repository.models.list(scope, { providerId: id })
        ).find((row) => row.modelId === modelId);
        const pricing = model?.pricing;
        if (pricing !== undefined && pricing.priceTableVersion !== "unpriced") {
          costUsd =
            (tokensIn * pricing.inputPer1k + tokensOut * pricing.outputPer1k) / 1000;
        }
      }
      return {
        text: maskSecrets(text),
        tokensIn,
        tokensOut,
        ms: Date.now() - startedAt,
        ...(costUsd === undefined ? {} : { costUsd }),
      };
    },
  };


  /**
   * Write the price table each model quoted, once per version (FR-OBS-003). The store ignores a
   * version it already has, so an old run's estimate can always be recomputed from the table
   * that was in force when it ran.
   */
  async function freezePriceTables(
    models: readonly Model[],
    at: string,
  ): Promise<void> {
    const byVersion = new Map<
      string,
      Record<string, { inputPer1k: number; outputPer1k: number }>
    >();

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
