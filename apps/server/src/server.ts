import { randomBytes } from "node:crypto";
import {
  createWriteStream,
  mkdirSync,
  writeFileSync,
  type WriteStream,
} from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";

import {
  WS_PATH,
  type GuardrailCheck,
  type Id,
  type Part,
  type ToolCall,
} from "@ace/contracts";
import { serve } from "@hono/node-server";
import {
  LOCAL_SCOPE,
  controlStoresFor,
  createApprovalService,
  createArtifactService,
  createBudgetService,
  createChatService,
  createEngineApp,
  createEventBus,
  createGraphService,
  createGuardrailEvaluator,
  createLogger,
  createPolicyService,
  createProviderService,
  createRunControls,
  createRunGateRegistry,
  createRunService,
  createToolGuardrailEvaluator,
  createWsHub,
  guardrailStoreFor,
  haltActiveRuns,
  loadEngineConfig,
  logDirectory,
  logFileName,
  mediaTypeForMime,
  newId,
  pruneOldLogs,
  recoverAfterCrash,
  startTimelinePopulation,
  workflowUpdatedEvent,
  type ArtifactMaterialiser,
  type ChatService,
  type CheckInput,
  type CheckRunner,
  type EngineEvent,
  type Logger,
  type McpService,
  type ProviderService,
  type RunService,
  type SecretMasker,
  type ToolProvider,
} from "@ace/engine";
import {
  SECRET_RULES,
  checkToolArgs,
  evaluateCheck,
  findSpans,
  redactSpans,
  type GuardrailInput,
} from "@ace/guardrails";
import { createProviderAdapterFactory, createRouter } from "@ace/providers";
import {
  FsBlobStore,
  InProcessPubSub,
  KeychainSecretStore,
  SessionTokenAuth,
  SqliteRepository,
  openDatabase,
} from "@ace/storage-local";
import { McpManager, ToolRegistry, registerBuiltinTools } from "@ace/tools";
import { WebSocketServer } from "ws";

export const ENGINE_VERSION = "0.1.0";

/**
 * `CheckInput` (the engine's port) → `GuardrailInput` (what the rule packs read).
 *
 * The two shapes say the same things differently on purpose: the engine names the *point* it is at
 * — loop counters, cost figures — while a check reads one measured `value` against one `limit`. This
 * is where the engine's vocabulary is turned into theirs, and it is the whole of the seam.
 *
 * `undefined` is silence, never a pass: a check handed nothing it can judge must not produce a
 * verdict, which is why each branch only sets a field it actually has (`evaluateCheck`'s rule 1).
 */
export function guardrailInputFor(
  check: GuardrailCheck,
  input: CheckInput,
): GuardrailInput {
  const base: GuardrailInput = {
    ...(input.text === undefined ? {} : { text: input.text }),
    ...(input.parts === undefined ? {} : { parts: input.parts }),
    ...(input.contract === undefined ? {} : { contract: input.contract }),
  };

  switch (check.type) {
    case "max_iterations":
      return input.loop === undefined ? base : { ...base, value: input.loop.iteration };
    case "max_tool_calls":
      return input.loop === undefined ? base : { ...base, value: input.loop.toolCalls };
    case "repeated_output":
      return input.loop === undefined
        ? base
        : { ...base, outputHashes: input.loop.outputHashes };
    case "max_tokens_per_node":
    case "max_cost_per_run":
    case "daily_budget":
      return input.cost === undefined
        ? base
        : { ...base, value: input.cost.costUsd, limit: input.cost.capUsd };
    default:
      // The tool-point checks (round 4 §2.2, FR-GRD-005/006) read `GuardrailInput.tool`, the same
      // `ToolPointInput` shape the engine's `CheckInput.tool` already carries — the last field this
      // seam maps, exactly as the loop and cost figures above.
      return input.tool === undefined ? base : { ...base, tool: input.tool };
  }
}

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

  /* ------------------------------------------------------- guardrails (R3) */

  /*
   * The one place `@ace/guardrails` meets the engine (Arch §13.2, CLAUDE.md §3.4 rule 3). The engine
   * declares `CheckRunner` and `SecretMasker`; the rule packs implement them, and the translation
   * between the two vocabularies lives here rather than in either package.
   */
  const checks: CheckRunner = {
    evaluate: (check, input) => evaluateCheck(check, guardrailInputFor(check, input)),
  };

  /** The data guardrail: always on, configured by nothing (FR-GRD-010, BR-15, D86). */
  const masker: SecretMasker = {
    mask: (text) => {
      const redaction = redactSpans(text, findSpans(text, SECRET_RULES));
      return { text: redaction.sanitized, types: redaction.redactedTypes };
    },
  };

  const guardrailStore = guardrailStoreFor(repository, LOCAL_SCOPE);

  const guardrailPolicies = createPolicyService({
    scope: LOCAL_SCOPE,
    policies: guardrailStore.policies,
    projects: guardrailStore.projects,
    policyUsage: guardrailStore.policyUsage,
    checks,
  });

  /** The `node.state` frame that goes with a node run the approval flow moved (Arch §19.1). */
  const emitNodeState = async (
    runId: string,
    nodeRun: Awaited<ReturnType<typeof repository.nodeRuns.get>>,
    status: "WAITING" | "RUNNING",
  ): Promise<void> => {
    if (nodeRun === null) return;
    const run = await repository.runs.get(LOCAL_SCOPE, runId);
    await bus.emit({
      type: "node.state",
      ...(run === null ? {} : { workflowId: run.workflowId }),
      runId,
      payload: {
        runId,
        nodeRunId: nodeRun.id,
        nodeId: nodeRun.nodeId,
        iteration: nodeRun.iteration,
        attempt: nodeRun.attempt,
        status,
      },
    });
  };

  const approvals = createApprovalService({
    scope: LOCAL_SCOPE,
    approvals: guardrailStore.approvals,
    nodeRuns: guardrailStore.nodeRuns,
    bus,
    /*
     * FR-GRD-013: the node is WAITING while a person decides, and the provider slot is already free
     * — output evaluation runs after `runGated` returned (D66). The row is moved here rather than in
     * the scheduler because the scheduler is the thing suspended on the answer.
     */
    onWaiting: async (request) => {
      const row = await repository.nodeRuns.update(LOCAL_SCOPE, request.nodeRunId, {
        status: "WAITING",
      });
      await emitNodeState(request.runId, row, "WAITING");
    },
    onDecided: async (request, decision) => {
      // Approved: the node picks up exactly where it paused. Rejected: it stays WAITING until the
      // evaluator fails it, so the row never claims to be running something nobody allowed.
      if (decision.decision !== "approve") return;
      const row = await repository.nodeRuns.update(LOCAL_SCOPE, request.nodeRunId, {
        status: "RUNNING",
      });
      await emitNodeState(request.runId, row, "RUNNING");
    },
  });

  const guardrails = createGuardrailEvaluator({
    scope: LOCAL_SCOPE,
    checks,
    masker,
    verdicts: guardrailStore.verdicts,
    bus,
    approvals,
  });

  /* --------------------------------------------------------- round 4: files, tools, chat */

  /*
   * The artifact store (FR-MM-001/002/009): rows in the repository, bytes in the content-addressed
   * blob store, the size limit and type allow-list its own. `POST /artifacts` and the two GETs are
   * the gateway's, this is the service behind them.
   */
  const artifactService = createArtifactService({
    scope: LOCAL_SCOPE,
    artifacts: repository.artifacts,
    blobs,
    settings: repository.settings,
  });

  /*
   * The tool registry: the six built-ins in §2.2's order, plus whatever MCP servers connect. The
   * built-ins default to the child-process sandbox (D13) and the canned search backend (D14), so
   * this needs no Docker and no network. The MCP manager registers a connected server's tools into
   * the same registry, and `DELETE /mcp-servers/:id` drops them again (FR-TOOL-007).
   */
  const toolRegistry = new ToolRegistry();
  registerBuiltinTools(toolRegistry);
  const mcpManager = new McpManager({ registry: toolRegistry });
  const toolLogger = logger.child({ subsystem: "tools" });

  /*
   * The executor's `ToolProvider` view (Arch §12.7): the registry keeps a `{definition, run}` pair
   * whose `run` takes `@ace/tools`' `ToolContext`; the executor hands a narrower `ToolRunContext`, so
   * this fills in the workspace scope and the tool logger the context needs.
   */
  const toolProvider: ToolProvider = {
    get: (name) => {
      const registered = toolRegistry.get(name);
      if (registered === undefined) return undefined;
      return {
        definition: registered.definition,
        run: (args, ctx) =>
          registered.implementation(args, {
            scope: LOCAL_SCOPE,
            runId: ctx.runId,
            sandboxDir: ctx.sandboxDir,
            logger: toolLogger,
            signal: ctx.signal,
          }),
      };
    },
  };

  /* `<dataDir>/sandbox/<runId>/` — the only folder a run's tools may touch (§2.2, NFR-SEC-03). */
  const sandboxDirFor = (runId: Id): string => join(config.dataDir, "sandbox", runId);

  /*
   * The multimodal materialiser (FR-MM-003/004): an Input node's `artifactIds` become media `Part`
   * references by MIME, and a model's produced media parts come back backed by a stored artifact.
   * Bytes never travel through an envelope — every part is a reference (BR-02).
   */
  const materialiser: ArtifactMaterialiser = {
    async inputParts(artifactIds) {
      const parts: Part[] = [];
      for (const id of artifactIds) {
        const artifact = await artifactService.get(id);
        if (artifact === null) continue;
        await artifactService.markReferenced(id);
        parts.push({
          type: mediaTypeForMime(artifact.mime),
          artifactId: artifact.id,
          mime: artifact.mime,
          name: artifact.name,
          size: artifact.size,
        });
      }
      return parts;
    },
    async store(parts) {
      const out: Part[] = [];
      for (const part of parts) {
        if (part.type === "text" || part.type === "json" || part.type === "code") {
          out.push(part);
          continue;
        }
        // A produced media part already backed by a stored artifact keeps its reference.
        const existing = await artifactService.get(part.artifactId);
        if (existing !== null) {
          await artifactService.markReferenced(existing.id);
          out.push(part);
          continue;
        }
        // The provider emitted a placeholder id (the mock cannot store bytes, §2.6): materialise a
        // stand-in artifact of the declared type so the produced part references a real row.
        const stored = await artifactService.upload(new Uint8Array(part.size), {
          mime: part.mime,
          name: part.name,
        });
        out.push({ ...part, artifactId: stored.id, size: stored.size });
      }
      return out;
    },
  };

  /* Persist one logged tool call, mirrored onto its node run in the same write (FR-TOOL-009). */
  const recordToolCall = async (runId: Id, call: ToolCall): Promise<void> => {
    await repository.toolCalls.append(LOCAL_SCOPE, runId, call);
  };

  /*
   * The tool point of the guardrail engine (FR-GRD-005/006, FR-TOOL-002). `checkToolArgs` is the
   * always-on arguments precondition (D217), and the same approval gate the output point uses opens
   * the card a destructive tool asks for (BR-14).
   */
  const toolGuardrails = createToolGuardrailEvaluator({
    scope: LOCAL_SCOPE,
    checks,
    verdicts: guardrailStore.verdicts,
    bus,
    validateArgs: checkToolArgs,
    approvals,
  });

  const budgets = createBudgetService({
    scope: LOCAL_SCOPE,
    projects: guardrailStore.projects,
    settings: guardrailStore.settings,
    usage: guardrailStore.usage,
    verdicts: guardrails,
  });

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
    // Arch §28: a key refused mid-run marks its provider AUTH_FAILED, through the provider service.
    recordProviderStatus: (providerId, found) =>
      providers.recordStatus(providerId, found),
    policies: guardrailPolicies,
    guardrails,
    budgets,
    approvals,
    /* Round 4's tool loop and multimodal materialisation (Arch §12.7, FR-TOOL-*, FR-MM-003/004). */
    tools: toolProvider,
    sandboxDirFor,
    artifacts: materialiser,
    recordToolCall,
    toolGuardrails,
  });

  const controls = createRunControls({
    ...controlStoresFor(repository, LOCAL_SCOPE),
    bus,
    gates,
    // D-054: a Stop rejects a WAITING node's approval before it answers, so no card outlives the run.
    approvals,
    logger: logger.child({ subsystem: "runs" }),
    // The controls never execute anything themselves; these three are the scheduler (FR-CTL-004/005).
    driveRecordedRun: (run) => runs.driveRecordedRun(run),
    drivePartialRun: (plan) => runs.drivePartialRun(plan),
    envelopesFor: (run, nodeId) => runs.envelopesFor(run, nodeId),
  });

  /*
   * The chat service (FR-CHAT-001..008): the workflow timeline and direct agent threads. It reaches
   * a node by id through the repository's `getById` join, prices with the same catalog the run
   * executor uses, and starts a run for `postMessage({ run: true })` through the run service. A
   * direct chat is text-only and touches no run (FR-CHAT-005), so it needs no tool wiring.
   */
  const chatService: ChatService = createChatService({
    scope: LOCAL_SCOPE,
    repository,
    bus,
    logger: logger.child({ subsystem: "chat" }),
    router,
    adapterFor: (providerId) => providers.adapterFor(providerId),
    modelsFor: () => repository.models.list(LOCAL_SCOPE, {}),
    runGated: async (providerId, fn) =>
      (await providers.semaphoreFor(providerId)).run(fn),
    resolveNode: async (nodeId) => {
      // The chat reply resolves its model through the same router the run engine uses, which reads
      // `catalogCache`. A run refreshes that cache at pre-flight (`checkProvider`); a direct chat has
      // no pre-flight, so refresh it here — `resolveNode` runs at the start of `chat()`, before the
      // model is resolved — so a model added a moment ago is chattable (FR-RTR-002).
      await refreshCatalogCache();
      const resolved = await repository.nodes.getById(LOCAL_SCOPE, nodeId);
      return resolved === null ? null : { node: resolved.node, projectId: resolved.projectId };
    },
    policies: guardrailPolicies,
    checks,
    masker,
    startRun: async (workflowId, request) => (await runs.beginRun(workflowId, request)).run,
  });

  /*
   * The timeline populator (FR-CHAT-001): derives every non-user timeline row from the persisted
   * run events, so the timeline replays identically after a reconnect (§2.3). Started once; its
   * unsubscribe is kept for shutdown.
   */
  const timeline = await startTimelinePopulation({
    scope: LOCAL_SCOPE,
    repository,
    bus,
    logger: logger.child({ subsystem: "chat" }),
  });

  /*
   * The MCP surface (FR-TOOL-007): register connects the server through the manager (registering its
   * tools into the shared registry), persists the row and emits `mcp.status`; check re-probes it; and
   * remove drops its tools and its row. The manager holds the live connections, the repository the
   * rows the servers screen reads.
   */
  const mcpService: McpService = {
    list: () => repository.mcpServers.list(LOCAL_SCOPE),
    get: (id) => repository.mcpServers.get(LOCAL_SCOPE, id),
    async create(request) {
      const id = newId();
      const server = await mcpManager.register(id, request);
      const created = await repository.mcpServers.create(LOCAL_SCOPE, server);
      await bus.emit({
        type: "mcp.status",
        payload: { serverId: id, status: created.status, toolCount: created.toolCount },
      });
      return created;
    },
    async check(id) {
      const checked = await mcpManager.check(id);
      // No live connection (e.g. after a restart, before a reconnect): the stored row is the truth.
      if (checked === undefined) return repository.mcpServers.get(LOCAL_SCOPE, id);
      const updated = await repository.mcpServers.updateStatus(LOCAL_SCOPE, id, {
        status: checked.status,
        toolCount: checked.toolCount,
        ...(checked.lastCheckedAt === undefined
          ? {}
          : { lastCheckedAt: checked.lastCheckedAt }),
        error: checked.error ?? null,
      });
      await bus.emit({
        type: "mcp.status",
        payload: { serverId: id, status: checked.status, toolCount: checked.toolCount },
      });
      return updated;
    },
    async remove(id) {
      await mcpManager.deregister(id);
      return repository.mcpServers.delete(LOCAL_SCOPE, id);
    },
  };

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
    /* Round 3's three sub-routers (§2.5, D121). */
    controls,
    guardrailPolicies,
    approvals,
    /* Round 4's routes (§2.4): artifacts, tools, MCP servers, timeline and direct chat. */
    artifacts: artifactService,
    tools: { list: () => toolRegistry.list() },
    mcp: mcpService,
    chat: chatService,
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

    // Round 4: stop deriving timeline rows and close every MCP connection before the DB closes.
    timeline.unsubscribe();
    await mcpManager.closeAll();

    hub.closeAll();
    wss.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    sqlite.close();
    await new Promise<void>((resolve) => logStream.end(resolve));
  }
}
