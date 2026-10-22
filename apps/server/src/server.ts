import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, mkdirSync, writeFileSync, type WriteStream } from 'node:fs';
import type { Server } from 'node:http';
import { createRequire } from 'node:module';
import { userInfo } from 'node:os';
import { join, relative, sep } from 'node:path';

import {
  WS_CLOSE_FORBIDDEN_ORIGIN,
  WS_PATH,
  type Artifact,
  type GuardrailCheck,
  type Id,
  type Part,
  type Timestamp,
  type ToolCall,
} from '@ace/contracts';
import {
  chunkKindFor,
  createChunker,
  createDocumentParser,
  createEmbedder,
  documentKind,
} from '@ace/context';
import { serve } from '@hono/node-server';
import {
  LOCAL_SCOPE,
  controlStoresFor,
  createAlwaysAllow,
  createApprovalService,
  createArtifactService,
  createBackupService,
  createBudgetService,
  createChatService,
  createContextGuard,
  createEngineApp,
  createEventBus,
  createGraphService,
  createGuardrailEvaluator,
  createIngestionWorker,
  createKnowledgeService,
  createLogger,
  createMemoryService,
  createModelSummariser,
  createPolicyService,
  createCheckpointService,
  createBenchService,
  createProcessService,
  createLanguageService,
  pyrightCommand,
  createProviderService,
  createDomainRegistry,
  createDomainService,
  createRunControls,
  createRunGateRegistry,
  createRunService,
  createSearchService,
  createTemplateService,
  createToolGuardrailEvaluator,
  createTraceService,
  createTruncatingSummariser,
  createUsageService,
  createWorkspaceService,
  createWsHub,
  guardrailStoreFor,
  HttpError,
  haltActiveRuns,
  isHostAllowed,
  isOriginAllowed,
  loadEngineConfig,
  logDirectory,
  logFileName,
  mediaTypeForMime,
  newId,
  createModelGateway,
  pruneOldLogs,
  recoverAfterCrash,
  requireUsageRepository,
  startTimelinePopulation,
  workflowUpdatedEvent,
  type ArtifactMaterialiser,
  type ArtifactService,
  type ChatService,
  type CheckInput,
  type CheckRunner,
  type EmbedderFor,
  type EngineEvent,
  type IngestJob,
  type Logger,
  type McpService,
  type CheckpointService,
  type ProviderService,
  type RunService,
  type SecretMasker,
  type ToolProvider,
} from '@ace/engine';
import {
  SECRET_RULES,
  checkToolArgs,
  evaluateCheck,
  findSpans,
  redactSpans,
  type GuardrailInput,
} from '@ace/guardrails';
import {
  createMockAdapter,
  createProviderAdapterFactory,
  createRouter,
  type CliDetector,
  type MockProviderAdapter,
  type ResolvedCommand,
} from '@ace/providers';
import {
  FsBlobStore,
  InProcessPubSub,
  InProcessQueue,
  KeychainSecretStore,
  SessionTokenAuth,
  SqliteRepository,
  createBackupStore,
  openDatabase,
} from '@ace/storage-local';
import {
  CannedSearchBackend,
  McpManager,
  ToolError,
  ToolRegistry,
  cannedResultsAt,
  classifyCommand,
  createAgentSession,
  createFsProjectFiles,
  type AgentCommandObserver,
  type OwnedAgentSession,
  createGitCheckpointStore,
  createProcessRunner,
  registerBuiltinTools,
  resolveAgentShell,
} from '@ace/tools';
import { WebSocketServer } from 'ws';

import { migrateFullAutoProviders } from './full-auto-migration.js';
import { createPricingLoader } from './pricing.js';
import { settingsSearchBackend } from './search-backend.js';

export const ENGINE_VERSION = '0.1.0';

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
export function guardrailInputFor(check: GuardrailCheck, input: CheckInput): GuardrailInput {
  const base: GuardrailInput = {
    ...(input.text === undefined ? {} : { text: input.text }),
    ...(input.parts === undefined ? {} : { parts: input.parts }),
    ...(input.contract === undefined ? {} : { contract: input.contract }),
  };

  switch (check.type) {
    case 'max_iterations':
      return input.loop === undefined ? base : { ...base, value: input.loop.iteration };
    case 'max_tool_calls':
      return input.loop === undefined ? base : { ...base, value: input.loop.toolCalls };
    case 'repeated_output':
      return input.loop === undefined ? base : { ...base, outputHashes: input.loop.outputHashes };
    case 'max_tokens_per_node':
    case 'max_cost_per_run':
    case 'daily_budget':
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

/**
 * The multimodal materialiser (FR-MM-003/004): an Input node's `artifactIds` become media `Part`
 * references by MIME, and a model's produced media parts come back backed by a stored artifact.
 * Bytes never travel through an envelope — every part that leaves here is a reference (BR-02).
 *
 * A produced media part is backed by exactly one of two things. Bytes the provider generated ride
 * beside it (`ProducedPart.bytes`, D216) and are stored here — `mock-media`'s PNG/MP3/MP4/ZIP, or a
 * real image model's output. Otherwise its `artifactId` must already name a stored artifact. There
 * is no third way: a reference to nothing is refused, and nothing is ever invented to back it — the
 * zero-filled stand-in that once did is D-082.
 */
export function createArtifactMaterialiser(
  artifacts: Pick<ArtifactService, 'get' | 'upload' | 'markReferenced'>,
): ArtifactMaterialiser {
  return {
    async inputParts(artifactIds) {
      const parts: Part[] = [];
      for (const id of artifactIds) {
        const artifact = await artifacts.get(id);
        if (artifact === null) continue;
        await artifacts.markReferenced(id);
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
    async store(produced) {
      const out: Part[] = [];
      for (const { part, bytes } of produced) {
        if (part.type === 'text' || part.type === 'json' || part.type === 'code') {
          out.push(part);
          continue;
        }
        if (bytes !== undefined) {
          // Store what the model produced — identical bytes dedupe to one artifact (FR-MM-002) —
          // and hand on a reference to it: the stored id in place of the placeholder, the stored
          // size. Marked referenced, so retention counts from this output (Arch §15.4).
          const stored = await artifacts.upload(bytes, { mime: part.mime, name: part.name });
          await artifacts.markReferenced(stored.id);
          out.push({ ...part, artifactId: stored.id, size: stored.size });
          continue;
        }
        // No bytes: the part must already reference a stored artifact, and it keeps that reference.
        const existing = await artifacts.get(part.artifactId);
        if (existing === null) {
          throw new Error(
            `The ${part.type} part "${part.name}" references artifact ${part.artifactId}, which is not stored, and came with no bytes to store.`,
          );
        }
        await artifacts.markReferenced(existing.id);
        out.push({ ...part, size: existing.size });
      }
      return out;
    },
  };
}

/** FR-SYS-001 / NFR-SEC-01: the engine binds the loopback interface and nothing else. */
export const BIND_HOST = '127.0.0.1';

/**
 * How often the artifact retention sweep runs after the one at start (Arch §15.4). The window is
 * seven days, so an hour late is nothing; what matters is that a long-running engine sweeps at all.
 */
export const ARTIFACT_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export interface StartEngineOptions {
  dataDir: string;
  /** Overrides the configured port. 0 asks the OS for a free one, which the tests rely on. */
  port?: number;
  env?: Record<string, string | undefined>;
  /**
   * The clock the artifact store stamps uploads and references with, and sweeps by (Arch §15.4,
   * round 4 §4 item 1: "retention sweep ... with an injectable clock"). Default: the wall clock. A
   * test injects one it can move, so "unreferenced for more than 7 days" takes no week to check.
   */
  clock?: () => Timestamp;
  /** Overrides {@link ARTIFACT_SWEEP_INTERVAL_MS}, for a test that watches the timer fire. */
  artifactSweepIntervalMs?: number;
  /**
   * Where the canned search index's result URLs point (D14, D-067). With no SearXNG the engine's
   * `web_search` answers from a canned index whose URLs sit under the reserved, unresolvable
   * `https://example.test`; the acceptance harness passes its local HTTP test server here so a
   * `web_search` → `web_fetch` chain completes offline (TC-TOOL-003). The host must still be on the
   * agent's `allowedDomains` — this moves where the pages are, never what is allowed.
   */
  cannedSearchBaseUrl?: string;
  /**
   * The mock adapter every `mock` provider row shares (default: a fresh one per engine). A test
   * injects its own to read `calls()` — TC-RAG-009 counts the summarisation calls on it. It changes
   * nothing about what the mock answers.
   */
  mockProvider?: MockProviderAdapter;
  /** X1: the terminal scan. Tests inject a fake; the real one runs the installed CLIs. */
  cliDetector?: CliDetector;
  /**
   * D286: where a CLI's binary is found for a call or a model listing — `PATH` by default. Tests
   * point it at a scripted CLI, so `pnpm test` never starts a real one.
   */
  cliResolve?: (bin: string) => ResolvedCommand | undefined;
  /**
   * PG-1.4 (D359): find, start and add the local Ollama without being asked — at start and on
   * `GET /providers/detect`. Only `ace-engine` turns it on; a test engine never starts anything.
   */
  autoLocalRuntime?: boolean;
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
  /**
   * The round 2 services, exposed for the acceptance harness and the CLI; and D300's checkpoints,
   * which chat's writing turns record into.
   */
  services: { providers: ProviderService; runs: RunService; checkpoints: CheckpointService };
  /**
   * The shared mock adapter every `mock` provider row uses (the injected one, else the engine's own),
   * exposed for the acceptance harness as `ports` and `services` are: TC-RAG-009 asserts exactly one
   * summarisation call through its `calls()`.
   */
  mockProvider: MockProviderAdapter;
  /**
   * Runs the artifact retention sweep once, now — by the injected clock — and answers the rows it
   * deleted (Arch §15.4). The engine already sweeps at start and every
   * {@link ARTIFACT_SWEEP_INTERVAL_MS}; this is for a test that must not wait for the timer. There is
   * deliberately no REST endpoint for it (§2.4 has none). After `stop()` it does nothing and
   * answers `[]`.
   */
  sweepArtifacts(): Promise<Artifact[]>;
  stop(): Promise<void>;
}

/** §2.10: 32 random bytes, hex, new on every start. */
export function generateSessionToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Write the token where a CLI can find it, readable by this user only (§2.10).
 * The mode is set at creation, so there is no window in which it exists world-readable.
 */
export function writeSessionTokenFile(dataDir: string, token: string): string {
  const path = join(dataDir, 'session-token');
  writeFileSync(path, token, { mode: 0o600 });
  return path;
}

/** `NT AUTHORITY\SYSTEM` by its well-known SID, which no Windows language translates. */
const SYSTEM_SID = '*S-1-5-18';

/**
 * [audit S-4] The `icacls` arguments that leave `path` to `user` and SYSTEM alone: `/inheritance:r`
 * drops every entry the file inherited from its folder, and `/grant:r` gives the two of them full
 * control, replacing any explicit entry they had.
 */
export function tokenFileAclArgs(path: string, user: string): string[] {
  return [path, '/inheritance:r', '/grant:r', `${user}:F`, `${SYSTEM_SID}:F`];
}

/** `DOMAIN\user` when Windows names a domain (or the machine), else the bare user name. */
export function windowsAccountName(username: string, domain: string | undefined): string {
  return domain === undefined || domain === '' ? username : `${domain}\\${username}`;
}

/** Runs a program without a shell and reports how it ended. Injected so a test runs no `icacls`. */
export type ExecFileRunner = (
  file: string,
  args: string[],
  done: (error: Error | null) => void,
) => void;

const runExecFile: ExecFileRunner = (file, args, done) => {
  execFile(file, args, { windowsHide: true }, (error) => done(error));
};

/**
 * [audit S-4] Windows ignores `mode: 0o600`, so the token file takes its folder's ACL — which can
 * let other principals read it (a sandbox users group, say). After writing it, `icacls` (no shell)
 * cuts it down to this user and SYSTEM. Best-effort and in the background: a failure is a warning,
 * never a failed start, and only the token file is touched — never the data directory's ACL.
 */
export function restrictTokenFileAcl(
  path: string,
  warn: (payload: Record<string, unknown>, message: string) => void,
  options: { platform?: NodeJS.Platform; user?: string; run?: ExecFileRunner } = {},
): void {
  if ((options.platform ?? process.platform) !== 'win32') return;
  const failed = (error: unknown): void =>
    warn(
      { subsystem: 'server', err: error },
      'could not restrict the session token file to this user',
    );
  try {
    const user = options.user ?? windowsAccountName(userInfo().username, process.env['USERDOMAIN']);
    (options.run ?? runExecFile)('icacls', tokenFileAclArgs(path, user), (error) => {
      if (error !== null) failed(error);
    });
  } catch (error) {
    failed(error);
  }
}

/** The §2.10 line the user copies to open the app. */
export function readyLine(url: string, webOrigin: string, token: string): string {
  return `ACE engine ready · ${url} · open ${webOrigin}/?token=${token}`;
}

/**
 * Start the engine: config, local adapters, HTTP and WebSocket.
 *
 * Exported rather than inlined into `main.ts` because the acceptance harness starts a real engine
 * on a random port with a temp data directory, and it has to be *this* engine, not a re-wiring of
 * it that could drift.
 */
export async function startEngine(options: StartEngineOptions): Promise<RunningEngine> {
  const env = options.env ?? process.env;
  mkdirSync(options.dataDir, { recursive: true });

  const config = loadEngineConfig({ dataDir: options.dataDir, env });
  const port = options.port ?? config.port;

  /* ----------------------------------------------------------------- logging */

  const logs = logDirectory(config.dataDir);
  pruneOldLogs(logs, config.logRetentionDays);
  const logStream: WriteStream = createWriteStream(join(logs, logFileName()), {
    flags: 'a',
  });
  const logger = createLogger({
    level: config.logLevel,
    destination: logStream,
  });

  /* ---------------------------------------------------------------- adapters */

  const { db, sqlite, backupPath, vectorExtension } = openDatabase({
    path: join(config.dataDir, 'ace.sqlite'),
  });
  if (backupPath !== undefined) {
    logger.info({ subsystem: 'storage', backupPath }, 'backed up the database before migrating');
  }

  // F8: without sqlite-vec the vector index answers by an exact cosine scan — correct, slower.
  if (vectorExtension === 'scan') {
    logger.warn(
      { subsystem: 'storage' },
      'sqlite-vec could not be loaded; vector search falls back to an exact scan',
    );
  }

  const repository = new SqliteRepository(db, sqlite, { vectorExtension });
  const pubsub = new InProcessPubSub<EngineEvent>();
  // Wired and returned rather than used here: artifacts arrive in round 4 and provider keys in
  // round 2, and both belong to the one composition root even before anything calls them.
  const blobs = new FsBlobStore(join(config.dataDir, 'blobs'));
  const secrets = new KeychainSecretStore();

  const token = generateSessionToken();
  const auth = new SessionTokenAuth(token);
  restrictTokenFileAcl(writeSessionTokenFile(config.dataDir, token), (payload, message) =>
    logger.warn(payload, message),
  );

  // Settings must exist before the origin guard reads them on the first request.
  await repository.settings.update(LOCAL_SCOPE, { dataDir: config.dataDir });

  /* ------------------------------------------------------------------ engine */

  const bus = createEventBus({ repository, scope: LOCAL_SCOPE, pubsub });
  // D355 (PG-2.3): a CLI provider an older engine left on Full auto is moved to Edit project files
  // before any provider is built or checked, with one notice. Never the reason the engine does not
  // start: the adapters already run an old `full_auto` row as `edit_files`.
  try {
    await migrateFullAutoProviders({ repository, scope: LOCAL_SCOPE, bus, logger });
  } catch (error) {
    logger.error({ subsystem: 'providers', err: error }, 'could not move Full auto providers');
  }
  // D300: every agent write is checkpointed in a private git store under the data dir, outside
  // the project's own .git (design §5.1). A checkpoint left recording by the last process is
  // marked failed at startup, below.
  const checkpoints = createCheckpointService({
    store: createGitCheckpointStore(config.dataDir),
    repository,
    scope: LOCAL_SCOPE,
    bus,
    logger: logger.child({ subsystem: 'checkpoints' }),
  });
  // Forge's project files (D299): a project folder is watched while a client subscribes to its scope.
  const workspace = createWorkspaceService({
    repository,
    scope: LOCAL_SCOPE,
    files: createFsProjectFiles(),
    bus,
    logger: logger.child({ subsystem: 'workspace' }),
    // D300: the person's own writes are never claimed by an agent's checkpoint
    onPersonWrite: (projectId, paths) => checkpoints.notePersonWrite(projectId, paths),
    // PG-5.2: nor what their own terminal command changes (the processes below say when one runs)
    onFilesChanged: (projectId, paths) => checkpoints.noteFilesChanged(projectId, paths),
  });
  // Forge's terminal (D301): a person's commands as supervised processes. Agents never get it.
  const processes = createProcessService({
    repository,
    scope: LOCAL_SCOPE,
    runner: createProcessRunner(),
    bus,
    logger: logger.child({ subsystem: 'processes' }),
    onPersonCommand: (projectId, processId, running) =>
      checkpoints.notePersonCommand(projectId, processId, running),
    // Task 14: Forge's Kill on a running background agent command goes to the run's agent session.
    killAgentCommand: async (runId, sessionProcessId) =>
      (await agentSessions.get(runId)?.processes.kill(sessionProcessId)) ?? false,
  });
  // Forge's Python IntelliSense: a Pyright language server per project, while it is being edited.
  const language = createLanguageService({
    repository,
    scope: LOCAL_SCOPE,
    logger: logger.child({ subsystem: 'language' }),
    pyright: pyrightCommand(createRequire(import.meta.url).resolve('pyright/langserver.index.js')),
  });
  const hub = createWsHub({
    bus,
    repository,
    scope: LOCAL_SCOPE,
    auth,
    logger,
    onProjectWatch: (projectId, watched) => {
      workspace.setWatched(projectId, watched).catch((error: unknown) => {
        logger.warn(
          {
            subsystem: 'workspace',
            projectId,
            reason: error instanceof Error ? error.message : String(error),
          },
          'could not change the project watch',
        );
      });
    },
  });

  /* --------------------------------------------------------- model serving */

  const mockProvider = options.mockProvider ?? createMockAdapter();
  const factory = createProviderAdapterFactory({
    mock: mockProvider,
    ...(options.cliDetector === undefined ? {} : { cliDetector: options.cliDetector }),
    ...(options.cliResolve === undefined ? {} : { cliResolve: options.cliResolve }),
  });

  /* FR-CTL-001..003: the one gate registry the scheduler registers into and the controls read. */
  const gates = createRunGateRegistry();

  const providers = createProviderService({
    repository,
    scope: LOCAL_SCOPE,
    secrets,
    factory,
    bus,
    logger: logger.child({ subsystem: 'providers' }),
    autoLocalRuntime: options.autoLocalRuntime === true,
  });

  /*
   * The model gateway (X1 §4.1): route, adapter, per-provider gate, catalog and price in one place.
   * Every caller below gets its model through it; the router reads the gateway's catalog lazily, so
   * a refresh takes effect without rewiring anything.
   */
  const gateway = await createModelGateway({
    providers,
    models: repository.models,
    scope: LOCAL_SCOPE,
    createRouter: (catalog) => createRouter(catalog),
  });
  const router = gateway.router;

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
    status: 'WAITING' | 'RUNNING',
  ): Promise<void> => {
    if (nodeRun === null) return;
    const run = await repository.runs.get(LOCAL_SCOPE, runId);
    await bus.emit({
      type: 'node.state',
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
        status: 'WAITING',
      });
      await emitNodeState(request.runId, row, 'WAITING');
    },
    onDecided: async (request, decision) => {
      // Approved: the node picks up exactly where it paused. Rejected: it stays WAITING until the
      // evaluator fails it, so the row never claims to be running something nobody allowed —
      // except an agentic node's command (D375): a denied command is fed back to the model and
      // the node goes on, so it is RUNNING again (and only from WAITING: never over an ending).
      if (decision.decision !== 'approve') {
        if (request.command === undefined) return;
        const current = await repository.nodeRuns.get(LOCAL_SCOPE, request.nodeRunId);
        if (current?.status !== 'WAITING') return;
      }
      const row = await repository.nodeRuns.update(LOCAL_SCOPE, request.nodeRunId, {
        status: 'RUNNING',
      });
      await emitNodeState(request.runId, row, 'RUNNING');
    },
    // D376: Always allow — the live run asks no more for that prefix, and the node keeps it.
    onAlways: (runId, nodeId, prefix) => alwaysAllow(runId, nodeId, prefix),
    logger: logger.child({ subsystem: 'approvals' }),
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
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });

  /*
   * Arch §15.4: an artifact lives until it has been unreferenced for 7 days. The sweep asks the
   * repository for rows past the window that nothing points at — an Input node's `artifactIds`, a
   * node run's output or input envelopes, a timeline message, a chat message — and deletes each row,
   * then its blob. One sweep at a time: a timer tick that lands while one is running joins it rather
   * than starting a second pass over the same rows. A failure is logged, never thrown into the timer.
   */
  const retentionLogger = logger.child({ subsystem: 'artifacts' });
  let sweeping: Promise<Artifact[]> | undefined;
  let sweepsStopped = false;
  const sweepArtifacts = (): Promise<Artifact[]> => {
    if (sweepsStopped) return Promise.resolve([]);
    sweeping ??= artifactService
      .sweepUnreferenced()
      .then((deleted) => {
        if (deleted.length > 0) {
          retentionLogger.info(
            { deleted: deleted.length, ids: deleted.map((artifact) => artifact.id) },
            'swept unreferenced artifacts',
          );
        }
        return deleted;
      })
      .catch((error: unknown): Artifact[] => {
        retentionLogger.error({ err: error }, 'artifact retention sweep failed');
        return [];
      })
      .finally(() => {
        sweeping = undefined;
      });
    return sweeping;
  };

  /*
   * The tool registry: the thirteen built-ins (§2.2's six, then X1's seven), plus whatever MCP
   * servers connect. The built-ins default to the child-process sandbox (D13) and, until Settings
   * name a SearXNG, the canned search backend (D14), so this needs no Docker and no network. The MCP manager registers a connected server's tools into
   * the same registry, and `DELETE /mcp-servers/:id` drops them again (FR-TOOL-007).
   */
  const toolRegistry = new ToolRegistry();
  registerBuiltinTools(toolRegistry, {
    // [audit U-3] SearXNG once Settings name one (D14, D-084), read at each search; the canned
    // index otherwise. It used to be the canned index always, whatever Settings said.
    searchBackend: settingsSearchBackend(
      async () => (await repository.settings.get(LOCAL_SCOPE)).searxngUrl,
      options.cannedSearchBaseUrl === undefined
        ? new CannedSearchBackend()
        : new CannedSearchBackend({}, cannedResultsAt(options.cannedSearchBaseUrl)),
    ),
  });
  const mcpManager = new McpManager({ registry: toolRegistry });
  /** [audit U-3] D16: whether MCP servers may be used at all, read when it matters. */
  const mcpEnabled = async (): Promise<boolean> =>
    (await repository.settings.get(LOCAL_SCOPE)).mcpEnabled;
  const toolLogger = logger.child({ subsystem: 'tools' });

  /*
   * The executor's `ToolProvider` view (Arch §12.7): the registry keeps a `{definition, run}` pair
   * whose `run` takes `@ace/tools`' `ToolContext`; the executor hands a narrower `ToolRunContext`, so
   * this fills in the workspace scope and the tool logger the context needs.
   */
  /*
   * Agentic nodes (D341): one session per run, shared by its nodes' tool calls — the reads behind
   * read-before-edit, the per-file write locks, and the background commands. Made on the run's first
   * node tool call and ended (its commands killed) when the run completes or the engine shuts down.
   * Chat turns pass no node id and get none, so they behave as before (D302).
   */
  const agentSessions = new Map<Id, OwnedAgentSession>();
  /**
   * PG-5.3 (D361): a run's commands as read-only rows of its project's processes, so Forge's
   * Terminal and Processes list show what an agent runs. The run's project is looked up once; the
   * feed's calls queue behind that lookup in order, and a run without a project shows nothing.
   */
  const agentCommandsFor = (runId: Id, projectDir: string): AgentCommandObserver => {
    const projectId = repository.runs
      .get(LOCAL_SCOPE, runId)
      .then((run) => run?.projectId)
      .catch(() => undefined);
    return {
      started(spec) {
        const rel = relative(projectDir, spec.cwd);
        const cwd = rel === '' || rel.startsWith('..') ? '' : rel.split(sep).join('/');
        const feed = projectId.then((id) =>
          id === undefined
            ? undefined
            : processes.observeAgentCommand(id, {
                runId,
                nodeId: spec.nodeId,
                command: spec.command,
                cwd,
                background: spec.background,
                ...(spec.processId === undefined ? {} : { sessionProcessId: spec.processId }),
              }),
        );
        return {
          output: (stream, data) => void feed.then((open) => open?.output(stream, data)),
          exited: (exitCode, failed) => void feed.then((open) => open?.exited(exitCode, failed)),
        };
      },
    };
  };
  const agentSessionFor = (runId: Id, projectDir: string): OwnedAgentSession => {
    let session = agentSessions.get(runId);
    if (session === undefined) {
      session = createAgentSession({ commands: agentCommandsFor(runId, projectDir) });
      agentSessions.set(runId, session);
    }
    return session;
  };
  const endAgentSession = async (runId: Id): Promise<void> => {
    const session = agentSessions.get(runId);
    if (session === undefined) return;
    agentSessions.delete(runId);
    await session.processes.killAll();
  };

  const toolProvider: ToolProvider = {
    get: (name) => {
      const registered = toolRegistry.get(name);
      if (registered === undefined) return undefined;
      return {
        definition: registered.definition,
        run: async (args, ctx) => {
          // [audit U-3] A server connected before MCP was turned off in Settings is not called.
          if (registered.definition.source === 'mcp' && !(await mcpEnabled())) {
            throw new ToolError(
              'unavailable',
              name,
              'MCP is turned off in Settings, so this MCP tool cannot run.',
            );
          }
          return registered.implementation(args, {
            scope: LOCAL_SCOPE,
            runId: ctx.runId,
            sandboxDir: ctx.sandboxDir,
            ...(ctx.projectDir === undefined ? {} : { projectDir: ctx.projectDir }),
            ...(ctx.nodeId === undefined || ctx.projectDir === undefined
              ? {}
              : { nodeId: ctx.nodeId, session: agentSessionFor(ctx.runId, ctx.projectDir) }),
            ...(ctx.allowedDomains === undefined ? {} : { allowedDomains: ctx.allowedDomains }),
            logger: toolLogger,
            signal: ctx.signal,
          });
        },
      };
    },
  };

  /* `<dataDir>/sandbox/<runId>/` — the only folder a run's tools may touch (§2.2, NFR-SEC-03). */
  const sandboxDirFor = (runId: Id): string => join(config.dataDir, 'sandbox', runId);

  const materialiser = createArtifactMaterialiser(artifactService);

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

  /* --------------------------------------------- round 5: knowledge, context, memory, usage */

  /*
   * A knowledge base names the provider and model its vectors come from (§2.1, F1): its embedder is
   * that provider's adapter with that model riding every call, batched at 32 (`createEmbedder`).
   */
  const embedderFor: EmbedderFor = async (kb) =>
    createEmbedder(await gateway.adapterFor(kb.embeddingProviderId), kb.embeddingModelId);

  /*
   * Hybrid search (FR-RAG-004) reads the repository's own gated indexes — never separate instances,
   * which would read and write past the storage transaction gate (NFR-REL-02).
   */
  const search = createSearchService({
    scope: LOCAL_SCOPE,
    knowledgeBases: repository.knowledgeBases,
    chunks: repository.kbChunks,
    vectors: repository.vectorIndex,
    keywords: repository.keywordIndex,
    embedderFor,
  });

  /*
   * The context point of the guardrail engine (FR-GRD-004) on the same rule packs and verdict store
   * every other point uses: retrieval-time stripping and PII through `inspect`/`record`, and the
   * ingestion-time PII check (`checkIngestText`, F6) the worker runs before chunking.
   */
  const contextGuard = createContextGuard({
    policies: guardrailPolicies,
    evaluator: checks,
    record: (target, verdict) => guardrails.record(target, verdict),
  });

  /*
   * Ingestion (Arch §21.3): the knowledge service records and queues, the worker drains the
   * in-process queue one document at a time — parse, PII, chunk, embed, store — and the service's
   * `wake` tells it there is work without waiting for its poll.
   */
  const ingestQueue = new InProcessQueue<IngestJob>();
  const knowledgeLogger = logger.child({ subsystem: 'knowledge' });
  const ingestion = createIngestionWorker({
    repository,
    scope: LOCAL_SCOPE,
    queue: ingestQueue,
    bus,
    parser: createDocumentParser(),
    chunker: createChunker(),
    embedderFor,
    checkContextText: contextGuard.checkIngestText,
    // The data guardrail the evaluator uses, over every document's text (BR-07, D86).
    masker,
    // A type the parser does not know is refused there with a reason; prose is only the fallback.
    chunkKindFor: (doc) => chunkKindFor(documentKind(doc) ?? 'text'),
    readArtifact: async (artifactId) => {
      const found = await artifactService.content(artifactId);
      return found === null ? null : { bytes: found.bytes };
    },
    logger: knowledgeLogger,
  });
  const knowledge = createKnowledgeService({
    repository,
    scope: LOCAL_SCOPE,
    providers,
    artifacts: artifactService,
    queue: ingestQueue,
    bus,
    wake: () => ingestion.wake(),
  });

  const memory = createMemoryService({ scope: LOCAL_SCOPE, repository, bus });
  const usage = createUsageService({
    usage: requireUsageRepository(repository),
    scope: LOCAL_SCOPE,
  });
  const trace = createTraceService({ repository, scope: LOCAL_SCOPE });

  /*
   * FR-RAG-010: over-budget upstream content is summarised by the receiving node's model, cached by
   * what was summarised; with no model, or when the call fails, the truncating summariser answers
   * and the reason is logged. Priced from the same catalog the router reads.
   */
  const summariser = createModelSummariser({
    adapterFor: (providerId) => gateway.adapterFor(providerId),
    runGated: (providerId, fn) => gateway.runGated(providerId, fn),
    cache: repository.summaryCache,
    scope: LOCAL_SCOPE,
    // The engine's clock when a test injects one, as the artifact store's is (13b review m6).
    now: options.clock ?? (() => new Date().toISOString()),
    fallback: createTruncatingSummariser(),
    onFallback: (reason) =>
      logger.warn({ subsystem: 'runs', reason }, 'model summary fell back to truncation'),
    pricingFor: async (providerId, modelId) => gateway.pricingFor(providerId, modelId),
  });

  /* X1 §4.2: a run's project folder — where an agent-route CLI works, and the project tools reach. */
  const projectFolderFor = async (runId: Id): Promise<string | undefined> => {
    const run = await repository.runs.get(LOCAL_SCOPE, runId);
    if (run === null) return undefined;
    const project = await repository.projects.get(LOCAL_SCOPE, run.projectId);
    return project === null || project.folderPath === '' ? undefined : project.folderPath;
  };

  /*
   * Domain (D303–D327): each live run's conversation — the messages waiting for a node's turn, the
   * turn a message may cut short, the envelopes the Brain's router holds — and the human's way into
   * it: `POST /runs/:runId/messages`, `/end` and `/envelopes/:id/route`. The run service registers
   * each drive's Domain here; the routes look it up.
   */
  const domains = createDomainRegistry({ bus, repository, scope: LOCAL_SCOPE });
  // D306: what Domain prices a turn with when its provider reported no cost. Ships empty.
  const pricing = createPricingLoader({ dataDir: config.dataDir, logger });
  const domainService = createDomainService({
    repository,
    scope: LOCAL_SCOPE,
    bus,
    domains,
    gates,
    pricing: () => pricing.current(),
    // D305: a budget raised above what was used resumes the run; the controls are built below.
    resume: (runId) => controls.resume(runId),
  });

  const runs = createRunService({
    gates,
    domains,
    repository,
    scope: LOCAL_SCOPE,
    bus,
    logger: logger.child({ subsystem: 'runs' }),
    router,
    adapterFor: (providerId) => gateway.adapterFor(providerId),
    checkProvider: async (providerId) => {
      // §2.7 item 2: a fresh check before every run, and the catalog the router reads is
      // refreshed with it, so a model added a moment ago is routable.
      const result = await providers.check(providerId);
      await gateway.refreshCatalog();
      return result;
    },
    runGated: (providerId, fn) => gateway.runGated(providerId, fn),
    // Arch §28: a key refused mid-run marks its provider AUTH_FAILED, through the provider service.
    recordProviderStatus: (providerId, found) => providers.recordStatus(providerId, found),
    policies: guardrailPolicies,
    guardrails,
    budgets,
    approvals,
    /* Round 4's tool loop and multimodal materialisation (Arch §12.7, FR-TOOL-*, FR-MM-003/004). */
    tools: toolProvider,
    sandboxDirFor,
    projectFolderFor,
    artifacts: materialiser,
    recordToolCall,
    toolGuardrails,
    // D376: an agentic node's commands are judged against its allowed commands.
    classifyCommand,
    // D375: the OS and the shell an agentic node's rules name — the shell `run_command` runs in.
    agentEnvironment: {
      os: process.platform,
      shell: resolveAgentShell({ platform: process.platform, env: process.env }).label,
    },
    /* Round 5's context, memory, retrieval, summaries and day totals (§2.2–§2.6). */
    summariser,
    search,
    contextGuard,
    memory,
    usage,
    // D285: a finished goal-driven node's result lands in its chat session before its final state
    // is announced. `chatService` is built below; a run only reaches this after startup.
    recordNodeTurn: async (turn) => {
      await chatService.recordRunTurn(turn);
    },
    // D300: a run in a project with a folder is one checkpoint.
    checkpoints,
  });

  const controls = createRunControls({
    ...controlStoresFor(repository, LOCAL_SCOPE),
    bus,
    gates,
    // D309: a Stop drops what was still waiting for a turn before it announces the end.
    domains,
    // D-054: a Stop rejects a WAITING node's approval before it answers, so no card outlives the run.
    approvals,
    // A Stop announces the day's totals before its `run.completed`, as every ending does (FR-OBS-002).
    usage,
    logger: logger.child({ subsystem: 'runs' }),
    // The controls never execute anything themselves; these three are the scheduler (FR-CTL-004/005).
    driveRecordedRun: (run) => runs.driveRecordedRun(run),
    // PG-5.4: a replay is driven by the same scheduler, answered from the source run's recording.
    ...(runs.driveReplayRun === undefined
      ? {}
      : { driveReplayRun: runs.driveReplayRun.bind(runs) }),
    drivePartialRun: (plan) => runs.drivePartialRun(plan),
    envelopesFor: (run, nodeId) => runs.envelopesFor(run, nodeId),
  });

  /*
   * The chat service (FR-CHAT-001..008): the workflow timeline and direct agent threads. It reaches
   * a node by id through the repository's `getById` join, prices with the same catalog the run
   * executor uses, and starts a run for `postMessage({ run: true })` through the run service. A
   * direct chat touches no run (FR-CHAT-005). D302: in a project with a folder it works there — a
   * CLI under its preset, an API model with the non-destructive project tools from the same
   * registry (`tools`), and each such writing turn is a checkpoint of D300's service
   * (`checkpoints`), so its reply carries the `checkpointId` the Changes card reviews.
   */
  const chatService: ChatService = createChatService({
    scope: LOCAL_SCOPE,
    repository,
    bus,
    logger: logger.child({ subsystem: 'chat' }),
    router,
    adapterFor: (providerId) => gateway.adapterFor(providerId),
    modelsFor: () => repository.models.list(LOCAL_SCOPE, {}),
    runGated: (providerId, fn) => gateway.runGated(providerId, fn),
    resolveNode: async (nodeId) => {
      // The chat reply resolves its model through the same router the run engine uses, which reads
      // the gateway's catalog. A run refreshes that catalog at pre-flight (`checkProvider`); a direct
      // chat has no pre-flight, so refresh it here — `resolveNode` runs at the start of `chat()`,
      // before the model is resolved — so a model added a moment ago is chattable (FR-RTR-002).
      await gateway.refreshCatalog();
      const resolved = await repository.nodes.getById(LOCAL_SCOPE, nodeId);
      return resolved === null
        ? null
        : {
            node: resolved.node,
            projectId: resolved.projectId,
            // D302: a `targetNodeId` must be a node of the same workflow.
            workflowId: resolved.node.workflowId,
          };
    },
    policies: guardrailPolicies,
    checks,
    masker,
    startRun: async (workflowId, request) => (await runs.beginRun(workflowId, request)).run,
    tools: toolProvider,
    checkpoints,
    // D302: a chat tool result passes the same context point a run's does (FR-GRD-004).
    contextGuard,
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
    logger: logger.child({ subsystem: 'chat' }),
  });

  /* Agentic nodes: a finished run's background commands do not outlive it (D341). */
  const stopAgentSessions = await bus.subscribe((event) => {
    if (event.type === 'run.completed' && event.runId !== undefined) {
      void endAgentSession(event.runId);
    }
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
      // [audit U-3] D16: with MCP off in Settings no server is connected — not even to try it.
      if (!(await mcpEnabled())) {
        throw new HttpError(
          'invalid_config',
          'validation_failed',
          'MCP is turned off in Settings. Turn it on to add an MCP server.',
          { setting: 'mcpEnabled' },
          false,
        );
      }
      const id = newId();
      const server = await mcpManager.register(id, request);
      const created = await repository.mcpServers.create(LOCAL_SCOPE, server);
      await bus.emit({
        type: 'mcp.status',
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
        ...(checked.lastCheckedAt === undefined ? {} : { lastCheckedAt: checked.lastCheckedAt }),
        error: checked.error ?? null,
      });
      await bus.emit({
        type: 'mcp.status',
        payload: { serverId: id, status: checked.status, toolCount: checked.toolCount },
      });
      return updated;
    },
    async remove(id) {
      await mcpManager.deregister(id);
      return repository.mcpServers.delete(LOCAL_SCOPE, id);
    },
  };

  /*
   * FR-SYS-009: anything the store still believes is running died with the last process — except a
   * run started from Domain, which stays open (D323): its turns that were in flight end FAILED
   * `crash`, and it is driven again, parking at once when it has nothing to do.
   */
  // D300: a checkpoint the last process left recording is failed — what changed since can't be
  // told apart from the person's work — before any run is driven again, so a reopened Domain run
  // starts a checkpoint of its own.
  await checkpoints.recover();
  const recovered = await recoverAfterCrash({
    repository,
    scope: LOCAL_SCOPE,
    bus,
    logger: logger.child({ subsystem: 'runs' }),
    // D-061: the approvals that process was waiting on can no longer be answered, so they go too.
    approvals,
    keepOpen: (run) => run.domain?.stayOpen === true,
  });
  for (const run of recovered.reopened) await runs.resumeOpenRun(run);

  /*
   * PG-1.5: a chat turn the last process accepted (202) but never answered — it died, or shut down,
   * mid-reply — gets its failed turn now, so no client is left "typing…" forever. Never the reason
   * the engine does not start.
   */
  try {
    await chatService.recoverOpenTurns();
  } catch (error) {
    logger.error({ subsystem: 'chat', err: error }, 'could not close chat turns left open');
  }

  /*
   * F7: a document the last process left mid-pipeline goes back to `pending` and is queued again —
   * never stuck `parsing` — and only then does the worker start draining, outside any transaction.
   */
  const requeued = await knowledge.recover();
  if (requeued > 0) knowledgeLogger.info({ requeued }, 're-queued interrupted documents');
  ingestion.start();

  /* FR-PRV-004: re-check every provider on a timer, so the UI's chips stay honest. */
  const stopPeriodicChecks = providers.startPeriodicChecks();

  /*
   * PG-1.4 (D359): the local Ollama is started (hidden) when it is installed and stopped, and its
   * provider added with its models — in the background, so a slow start never delays the engine.
   */
  if (options.autoLocalRuntime === true) {
    void providers.ensureLocalRuntime().catch((error: unknown) => {
      logger.warn({ subsystem: 'providers', err: error }, 'could not start the local Ollama');
    });
  }

  /* Arch §15.4: sweep what expired while the engine was off, then keep sweeping on a timer. */
  await sweepArtifacts();
  const sweepTimer = setInterval(
    () => void sweepArtifacts(),
    options.artifactSweepIntervalMs ?? ARTIFACT_SWEEP_INTERVAL_MS,
  );
  // Never the reason the process stays alive: shutdown clears it, and a CLI exit must not wait on it.
  sweepTimer.unref();

  const graph = createGraphService({
    repository,
    scope: LOCAL_SCOPE,
    logger: logger.child({ subsystem: 'graph' }),
    // §2.9: every successful graph-ops batch becomes one persisted workflow.updated event.
    onWorkflowUpdated: async (workflowId, version) => {
      await bus.emit(workflowUpdatedEvent(workflowId, version));
    },
    // Round 4 §2.4 (D-069): validation checks every agent's enabled tools against the live registry.
    tools: toolProvider,
    // [audit E-8] A project created without a folder gets `<dataDir>/projects/<id>`, not a folder
    // under whatever directory the engine was started from.
    projectsRoot: join(config.dataDir, 'projects'),
  });

  /*
   * D376: what the approval service's `onAlways` does — the prefix joins the live run's allowlist,
   * then the saved workflow's node through the graph service (version bump, workflow.updated). The
   * run snapshot is never written (BR-04).
   */
  const alwaysAllow = createAlwaysAllow({
    allowlistFor: (runId) => runs.allowlistFor(runId),
    workflowOf: async (runId) => (await repository.runs.get(LOCAL_SCOPE, runId))?.workflowId,
    graph,
    logger: logger.child({ subsystem: 'approvals' }),
  });

  /*
   * The onboarding templates (FR-ONB-002, F11): a template's project and workflow go in through the
   * graph service, `rag-qa`'s base and sample document through the knowledge and artifact services,
   * and what a failed instantiation created is removed again.
   */
  const templates = createTemplateService({
    graph,
    providers,
    createKnowledgeBase: (projectId, body) => knowledge.create(projectId, body),
    removeKnowledgeBase: (kbId) => knowledge.remove(kbId),
    addDocument: (kbId, body) => knowledge.addDocument(kbId, body),
    storeArtifact: (bytes, mime, name) => artifactService.upload(bytes, { mime, name }),
  });

  /*
   * ACE Bench (PG-5.6): tasks, experiments and their runs. Bench runs are ordinary runs recorded
   * by the bench and driven by the run service — guardrails, budgets, approvals and the event log
   * all apply — one at a time, so concurrency never skews one arm's latency.
   */
  const bench = createBenchService({
    bench: repository.bench,
    repository,
    scope: LOCAL_SCOPE,
    bus,
    logger,
    runs,
    buildVersion: ENGINE_VERSION,
  });
  await bench.start();

  /*
   * Backup and restore (FR-SYS-012, F12) on the live connection. `exclusive` keeps a repository
   * transaction from opening while `VACUUM INTO` or `ATTACH` runs, which both refuse to inside one.
   */
  const backup = createBackupService({
    store: createBackupStore({
      sqlite,
      dataDir: config.dataDir,
      blobsDir: join(config.dataDir, 'blobs'),
      settings: repository.settings,
      scope: LOCAL_SCOPE,
      exclusive: (fn) => repository.exclusive(fn),
    }),
    repository,
    scope: LOCAL_SCOPE,
    /*
     * Final-review M4: the restored rows are live at once, so what this process keeps about them
     * follows — the catalog cache the router and the summariser read is reloaded, and documents the
     * backup holds mid-pipeline are queued again, as a start does (F7). The data is restored either
     * way, so a failure here is logged rather than turned into a failed import.
     */
    afterImport: async () => {
      try {
        await gateway.refreshCatalog();
        const requeued = await knowledge.recover();
        if (requeued > 0) knowledgeLogger.info({ requeued }, 're-queued restored documents');
      } catch (error) {
        logger.warn({ subsystem: 'backup', err: error }, 'could not refresh after a restore');
      }
    },
  });

  // Filled once the server is bound: with `port: 0` the configured port is not the real one
  // (D301). The gateway reads this array on every request, so filling it in place is enough.
  const selfOrigins: string[] = [];
  // [audit S-7] The Host values a request may carry, from the same bound port, filled the same way.
  const selfHosts: string[] = [];
  const app = createEngineApp({
    repository,
    auth,
    logger: logger.child({ subsystem: 'gateway' }),
    scope: LOCAL_SCOPE,
    version: ENGINE_VERSION,
    graph,
    providers,
    runs,
    bus,
    selfOrigins,
    selfHosts,
    /* Round 3's three sub-routers (§2.5, D121). */
    controls,
    /* Domain (D309, D323): messages to a run's nodes, and ending a run started from Domain. */
    domain: domainService,
    guardrailPolicies,
    approvals,
    /* Round 4's routes (§2.4): artifacts, tools, MCP servers, timeline and direct chat. */
    artifacts: artifactService,
    tools: { list: () => toolRegistry.list() },
    mcp: mcpService,
    chat: chatService,
    /* Round 5's routes (§2.9): knowledge, search, memory, trace, usage, templates and backup. */
    knowledge,
    search,
    memory,
    trace,
    usage,
    templates,
    backup,
    /* IDE (D299): Forge's project files. */
    workspace,
    /* IDE (D301): Forge's terminal. */
    processes,
    /* IDE (D300): review, keep and revert agents' changes. */
    checkpoints,
    /* Forge's Python IntelliSense. */
    language,
    /* PG-5.6: ACE Bench. */
    bench,
  });

  /* -------------------------------------------------------------------- http */

  const server = await new Promise<Server>((resolve) => {
    const created = serve({ fetch: app.fetch, hostname: BIND_HOST, port }, () =>
      resolve(created as Server),
    );
  });

  const bound = server.address() as { port: number; address: string };
  const actualPort = bound.port;
  selfOrigins.push(`http://${BIND_HOST}:${actualPort}`, `http://localhost:${actualPort}`);
  selfHosts.push(`${BIND_HOST}:${actualPort}`, `localhost:${actualPort}`, `[::1]:${actualPort}`);
  const url = `http://${BIND_HOST}:${actualPort}`;

  /* --------------------------------------------------------------- websocket */

  const wss = new WebSocketServer({ noServer: true });

  const originDeps = { repository, scope: LOCAL_SCOPE, selfOrigins };

  server.on('upgrade', (request, socket, head) => {
    const requestUrl = new URL(request.url ?? '/', url);
    if (requestUrl.pathname !== WS_PATH) {
      socket.destroy();
      return;
    }
    const origin = request.headers.origin;
    const host = request.headers.host;

    isOriginAllowed(originDeps, origin).then(
      (allowed) => {
        wss.handleUpgrade(request, socket, head, (ws) => {
          // [audit S-7]: a DNS-rebound page's upgrade names its own host; refused like a foreign Origin.
          if (!isHostAllowed(selfHosts, host)) {
            logger.warn({ subsystem: 'ws', host }, 'refused a WebSocket for a foreign host');
            ws.close(WS_CLOSE_FORBIDDEN_ORIGIN, 'forbidden host');
            return;
          }
          if (!allowed) {
            // design §7: the same allow-list as REST. Completed, then closed rather than
            // destroyed, so the client learns why and does not retry (FR-SYS-003).
            logger.warn({ subsystem: 'ws', origin }, 'refused a WebSocket from a foreign origin');
            ws.close(WS_CLOSE_FORBIDDEN_ORIGIN, 'forbidden origin');
            return;
          }
          void hub.handleConnection(
            {
              send: (data) => ws.send(data),
              close: (code, reason) => ws.close(code, reason),
              // What the hub reads to close a socket that fell too far behind (D301).
              get bufferedAmount() {
                return ws.bufferedAmount;
              },
              on: (event, handler) => {
                if (event === 'message') ws.on('message', (data) => handler(String(data)));
                else ws.on('close', () => handler(''));
              },
            },
            requestUrl.searchParams.get('token') ?? undefined,
          );
        });
      },
      () => socket.destroy(),
    );
  });

  // Deliberately no banner here. Announcing readiness belongs to the caller, because the caller is
  // what installs the signal handlers — and nothing should be told the engine is ready before it
  // can shut down cleanly. See `runEngine` in cli.ts.
  logger.info({ subsystem: 'server', url }, 'engine ready');

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
    services: { providers, runs, checkpoints },
    mockProvider,
    sweepArtifacts,

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
    // No sweep starts once shutdown has, and one in flight finishes before the database closes.
    sweepsStopped = true;
    clearInterval(sweepTimer);
    await sweeping;
    // The document in flight finishes before the database closes; the rest are re-queued at start (F7).
    try {
      await ingestion.stop();
      // The bench queue stops after its current run, which the run service halts next.
      await bench.stop();
      await runs.shutdown();
      await haltActiveRuns({
        repository,
        scope: LOCAL_SCOPE,
        bus,
        logger: logger.child({ subsystem: 'runs' }),
        approvals,
        // [audit E-7] D323: a run started from Domain stays open across a restart, clean or not.
        keepOpen: (run) => run.domain?.stayOpen === true,
      });

      // Round 4: stop deriving timeline rows and close every MCP connection before the DB closes.
      timeline.unsubscribe();
      stopAgentSessions();
      await mcpManager.closeAll();
    } finally {
      // FR-SYS-008, D301: every terminal process stops, its whole tree with it, before the
      // database closes; none outlives the engine, even if an earlier step above rejected.
      workspace.stopAll();
      await processes.stopAll();
      await language.stopAll();
      // PG-1.4 (D359): an Ollama this engine started stops with it; one the person started stays.
      await providers.stopLocalRuntime().catch(() => undefined);
      await Promise.all([...agentSessions.keys()].map((runId) => endAgentSession(runId)));
    }
    hub.closeAll();
    wss.close();
    // `server.close()` stops accepting, then waits for every open connection to end. Node closes
    // one idle between requests itself, but not a socket a browser preconnected and sent nothing
    // on, or one with a request half sent — so with a browser open, shutdown waited minutes
    // (FR-SYS-008, found by the §7.1 cross-test). Idle connections are closed and the rest cut:
    // every run is already halted and recorded above.
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeIdleConnections();
    server.closeAllConnections();
    await closed;
    sqlite.close();
    await new Promise<void>((resolve) => logStream.end(resolve));
  }
}
