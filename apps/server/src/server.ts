import { randomBytes } from "node:crypto";
import {
  createWriteStream,
  mkdirSync,
  writeFileSync,
  type WriteStream,
} from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";

import { WS_PATH } from "@ace/contracts";
import { serve } from "@hono/node-server";
import {
  LOCAL_SCOPE,
  createEngineApp,
  createEventBus,
  createGraphService,
  createLogger,
  createProviderService,
  createRunGateRegistry,
  createRunService,
  createWsHub,
  haltActiveRuns,
  loadEngineConfig,
  logDirectory,
  logFileName,
  pruneOldLogs,
  recoverAfterCrash,
  workflowUpdatedEvent,
  type EngineEvent,
  type Logger,
  type ProviderService,
  type RunService,
} from "@ace/engine";
import { createProviderAdapterFactory, createRouter } from "@ace/providers";
import {
  FsBlobStore,
  InProcessPubSub,
  KeychainSecretStore,
  SessionTokenAuth,
  SqliteRepository,
  openDatabase,
} from "@ace/storage-local";
import { WebSocketServer } from "ws";

export const ENGINE_VERSION = "0.1.0";

/** FR-SYS-001 / NFR-SEC-01: the engine binds the loopback interface and nothing else. */
export const BIND_HOST = "127.0.0.1";

export interface StartEngineOptions {
  dataDir: string;
  /** Overrides the configured port. 0 asks the OS for a free one, which the tests rely on. */
  port?: number;
  env?: Record<string, string | undefined>;
}

export interface RunningEngine {
  url: string;
  wsUrl: string;
  port: number;
  /** The address the socket is actually bound to — the ground truth for FR-SYS-001. */
  address: string;
  token: string;
  logger: Logger;
  /** Adapters the later rounds build on, exposed so the composition root stays the only wiring. */
  ports: {
    repository: SqliteRepository;
    blobs: FsBlobStore;
    secrets: KeychainSecretStore;
  };
  /** The round 2 services, exposed for the acceptance harness and the CLI. */
  services: { providers: ProviderService; runs: RunService };
  stop(): Promise<void>;
}

/** §2.10: 32 random bytes, hex, new on every start. */
export function generateSessionToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Write the token where a CLI can find it, readable by this user only (§2.10).
 * The mode is set at creation, so there is no window in which it exists world-readable.
 */
export function writeSessionTokenFile(dataDir: string, token: string): string {
  const path = join(dataDir, "session-token");
  writeFileSync(path, token, { mode: 0o600 });
  return path;
}

/** The §2.10 line the user copies to open the app. */
export function readyLine(
  url: string,
  webOrigin: string,
  token: string,
): string {
  return `ACE engine ready · ${url} · open ${webOrigin}/?token=${token}`;
}

/**
 * Start the engine: config, local adapters, HTTP and WebSocket.
 *
 * Exported rather than inlined into `main.ts` because the acceptance harness starts a real engine
 * on a random port with a temp data directory, and it has to be *this* engine, not a re-wiring of
 * it that could drift.
 */
export async function startEngine(
  options: StartEngineOptions,
): Promise<RunningEngine> {
  const env = options.env ?? process.env;
  mkdirSync(options.dataDir, { recursive: true });

  const config = loadEngineConfig({ dataDir: options.dataDir, env });
  const port = options.port ?? config.port;

  /* ----------------------------------------------------------------- logging */

  const logs = logDirectory(config.dataDir);
  pruneOldLogs(logs, config.logRetentionDays);
  const logStream: WriteStream = createWriteStream(join(logs, logFileName()), {
    flags: "a",
  });
  const logger = createLogger({
    level: config.logLevel,
    destination: logStream,
  });

  /* ---------------------------------------------------------------- adapters */

  const { db, sqlite, backupPath } = openDatabase({
    path: join(config.dataDir, "ace.sqlite"),
  });
  if (backupPath !== undefined) {
    logger.info(
      { subsystem: "storage", backupPath },
      "backed up the database before migrating",
    );
  }

  const repository = new SqliteRepository(db, sqlite);
  const pubsub = new InProcessPubSub<EngineEvent>();
  // Wired and returned rather than used here: artifacts arrive in round 4 and provider keys in
  // round 2, and both belong to the one composition root even before anything calls them.
  const blobs = new FsBlobStore(join(config.dataDir, "blobs"));
  const secrets = new KeychainSecretStore();

  const token = generateSessionToken();
  const auth = new SessionTokenAuth(token);
  writeSessionTokenFile(config.dataDir, token);

  // Settings must exist before the origin guard reads them on the first request.
  await repository.settings.update(LOCAL_SCOPE, { dataDir: config.dataDir });

  /* ------------------------------------------------------------------ engine */

  const bus = createEventBus({ repository, scope: LOCAL_SCOPE, pubsub });
  const hub = createWsHub({
    bus,
    repository,
    scope: LOCAL_SCOPE,
    auth,
    logger,
  });

  /* --------------------------------------------------------- model serving */

  const factory = createProviderAdapterFactory();

  /* FR-CTL-001..003: the one gate registry the scheduler registers into and the controls read. */
  const gates = createRunGateRegistry();

  const providers = createProviderService({
    repository,
    scope: LOCAL_SCOPE,
    secrets,
    factory,
    bus,
    logger: logger.child({ subsystem: "providers" }),
  });

  // The router reads the catalog lazily, so a refresh takes effect without rewiring anything.
  let catalogCache: Awaited<ReturnType<typeof repository.models.list>> = [];
  const refreshCatalogCache = async (): Promise<void> => {
    catalogCache = await repository.models.list(LOCAL_SCOPE, {});
  };
  await refreshCatalogCache();

  const router = createRouter(() =>
    catalogCache.map((model) => ({
      providerId: model.providerId,
      modelId: model.modelId,
      available: model.available,
      inputTypes: model.inputTypes,
      outputTypes: model.outputTypes,
      ...(model.pricing === undefined ? {} : { pricing: model.pricing }),
    })),
  );

  const runs = createRunService({
    gates,
    repository,
    scope: LOCAL_SCOPE,
    bus,
    logger: logger.child({ subsystem: "runs" }),
    router,
    adapterFor: (providerId) => providers.adapterFor(providerId),
    checkProvider: async (providerId) => {
      // §2.7 item 2: a fresh check before every run, and the catalog the router reads is
      // refreshed with it, so a model added a moment ago is routable.
      const result = await providers.check(providerId);
      await refreshCatalogCache();
      return result;
    },
    runGated: async (providerId, fn) =>
      (await providers.semaphoreFor(providerId)).run(fn),
  });

  /* FR-SYS-009: anything the store still believes is running died with the last process. */
  await recoverAfterCrash({
    repository,
    scope: LOCAL_SCOPE,
    bus,
    logger: logger.child({ subsystem: "runs" }),
  });

  /* FR-PRV-004: re-check every provider on a timer, so the UI's chips stay honest. */
  const stopPeriodicChecks = providers.startPeriodicChecks();

  const graph = createGraphService({
    repository,
    scope: LOCAL_SCOPE,
    logger: logger.child({ subsystem: "graph" }),
    // §2.9: every successful graph-ops batch becomes one persisted workflow.updated event.
    onWorkflowUpdated: async (workflowId, version) => {
      await bus.emit(workflowUpdatedEvent(workflowId, version));
    },
  });

  const selfOrigins = [
    `http://${BIND_HOST}:${port}`,
    `http://localhost:${port}`,
  ];
  const app = createEngineApp({
    repository,
    auth,
    logger: logger.child({ subsystem: "gateway" }),
    scope: LOCAL_SCOPE,
    version: ENGINE_VERSION,
    graph,
    providers,
    runs,
    bus,
    selfOrigins,
  });

  /* -------------------------------------------------------------------- http */

  const server = await new Promise<Server>((resolve) => {
    const created = serve({ fetch: app.fetch, hostname: BIND_HOST, port }, () =>
      resolve(created as Server),
    );
  });

  const bound = server.address() as { port: number; address: string };
  const actualPort = bound.port;
  const url = `http://${BIND_HOST}:${actualPort}`;

  /* --------------------------------------------------------------- websocket */

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const requestUrl = new URL(request.url ?? "/", url);
    if (requestUrl.pathname !== WS_PATH) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      void hub.handleConnection(
        {
          send: (data) => ws.send(data),
          close: (code, reason) => ws.close(code, reason),
          on: (event, handler) => {
            if (event === "message")
              ws.on("message", (data) => handler(String(data)));
            else ws.on("close", () => handler(""));
          },
        },
        requestUrl.searchParams.get("token") ?? undefined,
      );
    });
  });

  // Deliberately no banner here. Announcing readiness belongs to the caller, because the caller is
  // what installs the signal handlers — and nothing should be told the engine is ready before it
  // can shut down cleanly. See `runEngine` in cli.ts.
  logger.info({ subsystem: "server", url }, "engine ready");

  // A second Ctrl-C, or a stop() from a test that already stopped, must not run the shutdown
  // twice: the second pass would read a closed database.
  let stopping: Promise<void> | undefined;

  return {
    url,
    wsUrl: `ws://${BIND_HOST}:${actualPort}${WS_PATH}`,
    port: actualPort,
    address: bound.address,
    token,
    logger,
    ports: { repository, blobs, secrets },
    services: { providers, runs },

    /**
     * FR-SYS-008: stop dispatching, abort what is in flight, record the halt, then close.
     *
     * The order is the point. Runs are aborted and halted *before* the database closes, so the
     * `HALTED shutdown` rows and their events are written rather than lost — a run that vanishes
     * mid-history is indistinguishable from a crash, which is the one thing this has to avoid.
     */
    async stop() {
      stopping ??= shutdown();
      return stopping;
    },
  };

  async function shutdown(): Promise<void> {
    stopPeriodicChecks();
    await runs.shutdown();
    await haltActiveRuns({
      repository,
      scope: LOCAL_SCOPE,
      bus,
      logger: logger.child({ subsystem: "runs" }),
    });

    hub.closeAll();
    wss.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    sqlite.close();
    await new Promise<void>((resolve) => logStream.end(resolve));
  }
}
