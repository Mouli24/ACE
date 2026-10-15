import {
  ModelSchema,
  NodeRunSchema,
  RunSchema,
  type CliPermission,
  type CursorQuery,
  type DataType,
  type Id,
  type Model,
  type ModelQuery,
  type NodeRun,
  type Page,
  type Provider,
  type ProviderState,
  type ProviderType,
  type Run,
} from '@ace/contracts';
import type {
  ModelRepository,
  NodeRunPatch,
  NodeRunRepository,
  PriceTable,
  PriceTableRepository,
  ProviderPatch,
  ProviderRepository,
  RunPatch,
  RunRepository,
  Scope,
} from '@ace/engine';
import { and, asc, desc, eq, inArray, isNotNull, like, lt, or, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';

import type * as schema from './schema.js';
import { models, nodeRuns, priceTables, providers, runs } from './schema.js';
import { toJsonColumn } from './secret-guard.js';

type Db = BetterSQLite3Database<typeof schema>;

/**
 * The round 2 repositories (Arch §15.3).
 *
 * Split out of `repository.ts` so one file stays one round's worth of tables; `SqliteRepository`
 * composes them. Every JSON column goes through `toJsonColumn`, so BR-07 is enforced by the
 * storage layer rather than trusted to each caller.
 */

/* -------------------------------------------------------------------------- */
/* Row <-> domain                                                              */
/* -------------------------------------------------------------------------- */

type ProviderRow = typeof providers.$inferSelect;
type ModelRow = typeof models.$inferSelect;
type PriceTableRow = typeof priceTables.$inferSelect;
type RunRow = typeof runs.$inferSelect;
type NodeRunRow = typeof nodeRuns.$inferSelect;

function toProvider(row: ProviderRow): Provider {
  return {
    id: row.id,
    type: row.type as ProviderType,
    name: row.name,
    ...(row.baseUrl === null ? {} : { baseUrl: row.baseUrl }),
    keySet: row.keySet,
    status: row.status as ProviderState,
    ...(row.statusMessage === null ? {} : { statusMessage: row.statusMessage }),
    ...(row.lastCheckedAt === null ? {} : { lastCheckedAt: row.lastCheckedAt }),
    concurrency: row.concurrency,
    ...(row.cliPermission === null ? {} : { cliPermission: row.cliPermission as CliPermission }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toModel(row: ModelRow): Model {
  return ModelSchema.parse({
    id: row.id,
    providerId: row.providerId,
    modelId: row.modelId,
    displayName: row.displayName,
    inputTypes: JSON.parse(row.inputTypes),
    outputTypes: JSON.parse(row.outputTypes),
    contextWindow: row.contextWindow,
    supportsTools: row.supportsTools,
    supportsJson: row.supportsJson,
    available: row.available,
    source: row.source,
    lastCheckedAt: row.lastCheckedAt,
    ...(row.pricing === null ? {} : { pricing: JSON.parse(row.pricing) }),
    ...(row.description === null ? {} : { description: row.description }),
    ...(row.resolvedModelId === null ? {} : { resolvedModelId: row.resolvedModelId }),
    ...(row.unavailableReason === null ? {} : { unavailableReason: row.unavailableReason }),
  });
}

function toPriceTable(row: PriceTableRow): PriceTable {
  return { version: row.version, data: JSON.parse(row.data), createdAt: row.createdAt };
}

function toRun(row: RunRow): Run {
  return RunSchema.parse({
    id: row.id,
    workflowId: row.workflowId,
    projectId: row.projectId,
    status: row.status,
    ...(row.haltReason === null ? {} : { haltReason: row.haltReason }),
    snapshot: JSON.parse(row.snapshot),
    inputs: JSON.parse(row.inputs),
    preflightIssues: JSON.parse(row.preflightIssues),
    totals: JSON.parse(row.totals),
    startedAt: row.startedAt,
    ...(row.endedAt === null ? {} : { endedAt: row.endedAt }),
    ...(row.durationMs === null ? {} : { durationMs: row.durationMs }),
    ...(row.finalOutput === null ? {} : { finalOutput: JSON.parse(row.finalOutput) }),
    // Round 3 (§2.1, §2.3). A run written before the run-columns migration reads NULL here and the
    // field stays absent, which is what `Run` allows while these are optional (D71).
    ...(row.pausedAt === null ? {} : { pausedAt: row.pausedAt }),
    ...(row.allowedActions === null ? {} : { allowedActions: JSON.parse(row.allowedActions) }),
    ...(row.budgetHalt === null ? {} : { budgetHalt: JSON.parse(row.budgetHalt) }),
    ...(row.restartedFromRunId === null ? {} : { restartedFromRunId: row.restartedFromRunId }),
    // PG-5.4: NULL on every run that is not a replay, and absent then.
    ...(row.replayOf === null ? {} : { replayOf: row.replayOf }),
    // Domain (D305, D312). NULL on runs from before Domain, which stays absent.
    ...(row.blockedReason === null ? {} : { blockedReason: row.blockedReason }),
    ...(row.domain === null ? {} : { domain: JSON.parse(row.domain) }),
    ...(row.goal === null ? {} : { goal: row.goal }),
  });
}

function toNodeRun(row: NodeRunRow): NodeRun {
  return NodeRunSchema.parse({
    id: row.id,
    runId: row.runId,
    nodeId: row.nodeId,
    iteration: row.iteration,
    attempt: row.attempt,
    status: row.status,
    ...(row.failureReason === null ? {} : { failureReason: row.failureReason }),
    ...(row.error === null ? {} : { error: JSON.parse(row.error) }),
    ...(row.modelUsed === null ? {} : { modelUsed: JSON.parse(row.modelUsed) }),
    inputEnvelopes: JSON.parse(row.inputEnvelopes),
    ...(row.output === null ? {} : { output: JSON.parse(row.output) }),
    ...(row.prompt === null ? {} : { prompt: JSON.parse(row.prompt) }),
    usage: JSON.parse(row.usage),
    verdicts: JSON.parse(row.verdicts),
    toolCalls: JSON.parse(row.toolCalls),
    ...(row.approvals === null ? {} : { approvals: JSON.parse(row.approvals) }),
    ...(row.guardrailPolicy === null ? {} : { guardrailPolicy: JSON.parse(row.guardrailPolicy) }),
    ...(row.loopStop === null ? {} : { loopStop: row.loopStop }),
    ...(row.reusedFromNodeRunId === null ? {} : { reusedFromNodeRunId: row.reusedFromNodeRunId }),
    ...(row.trigger === null ? {} : { trigger: JSON.parse(row.trigger) }),
    // Round 5 (§2.2, §2.4, D233). A node run written before round 5 reads NULL, which stays absent.
    ...(row.sources === null ? {} : { sources: JSON.parse(row.sources) }),
    ...(row.droppedSources === null ? {} : { droppedSources: JSON.parse(row.droppedSources) }),
    ...(row.memoryOps === null ? {} : { memoryOps: JSON.parse(row.memoryOps) }),
    ...(row.startedAt === null ? {} : { startedAt: row.startedAt }),
    ...(row.endedAt === null ? {} : { endedAt: row.endedAt }),
    ...(row.durationMs === null ? {} : { durationMs: row.durationMs }),
  });
}

/** Drop the keys a patch left undefined, so an update never blanks a column by accident. */
function definedOnly<T extends object>(patch: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

/* -------------------------------------------------------------------------- */
/* Repositories                                                                */
/* -------------------------------------------------------------------------- */

export function createProviderRepository(db: Db): ProviderRepository {
  return {
    create: async (scope: Scope, provider: Provider) => {
      db.insert(providers)
        .values({
          id: provider.id,
          workspaceId: scope.workspaceId,
          type: provider.type,
          name: provider.name,
          baseUrl: provider.baseUrl ?? null,
          keySet: provider.keySet,
          status: provider.status,
          statusMessage: provider.statusMessage ?? null,
          lastCheckedAt: provider.lastCheckedAt ?? null,
          concurrency: provider.concurrency,
          cliPermission: provider.cliPermission ?? null,
          createdAt: provider.createdAt,
          updatedAt: provider.updatedAt,
        })
        .run();
      return provider;
    },

    get: async (scope: Scope, id: Id) => {
      const row = db
        .select()
        .from(providers)
        .where(and(eq(providers.workspaceId, scope.workspaceId), eq(providers.id, id)))
        .get();
      return row === undefined ? null : toProvider(row);
    },

    list: async (scope: Scope) =>
      db
        .select()
        .from(providers)
        .where(eq(providers.workspaceId, scope.workspaceId))
        .orderBy(asc(providers.id))
        .all()
        .map(toProvider),

    update: async (scope: Scope, id: Id, patch: ProviderPatch) => {
      const values = definedOnly(patch);
      if (Object.keys(values).length > 0) {
        db.update(providers)
          .set(values)
          .where(and(eq(providers.workspaceId, scope.workspaceId), eq(providers.id, id)))
          .run();
      }

      const row = db
        .select()
        .from(providers)
        .where(and(eq(providers.workspaceId, scope.workspaceId), eq(providers.id, id)))
        .get();
      return row === undefined ? null : toProvider(row);
    },

    delete: async (scope: Scope, id: Id) =>
      db
        .delete(providers)
        .where(and(eq(providers.workspaceId, scope.workspaceId), eq(providers.id, id)))
        .run().changes > 0,
  };
}

export function createModelRepository(db: Db): ModelRepository {
  const rowFor = (scope: Scope, model: Model): typeof models.$inferInsert => ({
    id: model.id,
    workspaceId: scope.workspaceId,
    providerId: model.providerId,
    modelId: model.modelId,
    displayName: model.displayName,
    inputTypes: toJsonColumn(model.inputTypes, `model(${model.modelId}).inputTypes`),
    outputTypes: toJsonColumn(model.outputTypes, `model(${model.modelId}).outputTypes`),
    contextWindow: model.contextWindow,
    supportsTools: model.supportsTools,
    supportsJson: model.supportsJson,
    available: model.available,
    source: model.source,
    lastCheckedAt: model.lastCheckedAt,
    pricing:
      model.pricing === undefined
        ? null
        : toJsonColumn(model.pricing, `model(${model.modelId}).pricing`),
    description: model.description ?? null,
    resolvedModelId: model.resolvedModelId ?? null,
    unavailableReason: model.unavailableReason ?? null,
  });

  /** A JSON array column holds `["text","image"]`, so a type test is a substring test. */
  const hasType = (column: AnySQLiteColumn, type: DataType) => sql`${column} LIKE ${`%"${type}"%`}`;

  return {
    replaceForProvider: async (scope: Scope, providerId: Id, catalog: readonly Model[]) => {
      db.delete(models)
        .where(and(eq(models.workspaceId, scope.workspaceId), eq(models.providerId, providerId)))
        .run();

      for (const model of catalog) db.insert(models).values(rowFor(scope, model)).run();
    },

    list: async (scope: Scope, query: ModelQuery) =>
      db
        .select()
        .from(models)
        .where(
          and(
            eq(models.workspaceId, scope.workspaceId),
            query.providerId === undefined ? undefined : eq(models.providerId, query.providerId),
            query.available === undefined ? undefined : eq(models.available, query.available),
            query.inputType === undefined ? undefined : hasType(models.inputTypes, query.inputType),
            query.outputType === undefined
              ? undefined
              : hasType(models.outputTypes, query.outputType),
          ),
        )
        .orderBy(asc(models.id))
        .all()
        .map(toModel),

    find: async (scope: Scope, providerId: Id, modelId: string) => {
      const row = db
        .select()
        .from(models)
        .where(
          and(
            eq(models.workspaceId, scope.workspaceId),
            eq(models.providerId, providerId),
            eq(models.modelId, modelId),
          ),
        )
        .get();
      return row === undefined ? null : toModel(row);
    },

    deleteForProvider: async (scope: Scope, providerId: Id) => {
      db.delete(models)
        .where(and(eq(models.workspaceId, scope.workspaceId), eq(models.providerId, providerId)))
        .run();
    },
  };
}

export function createPriceTableRepository(db: Db): PriceTableRepository {
  return {
    /** `DO NOTHING`, not `DO UPDATE`: a published version is frozen (FR-OBS-003). */
    put: async (scope: Scope, table: PriceTable) => {
      db.insert(priceTables)
        .values({
          workspaceId: scope.workspaceId,
          version: table.version,
          data: toJsonColumn(table.data, `priceTable(${table.version})`),
          createdAt: table.createdAt,
        })
        .onConflictDoNothing()
        .run();
    },

    get: async (scope: Scope, version: string) => {
      const row = db
        .select()
        .from(priceTables)
        .where(
          and(eq(priceTables.workspaceId, scope.workspaceId), eq(priceTables.version, version)),
        )
        .get();
      return row === undefined ? null : toPriceTable(row);
    },

    list: async (scope: Scope) =>
      db
        .select()
        .from(priceTables)
        .where(eq(priceTables.workspaceId, scope.workspaceId))
        .orderBy(asc(priceTables.version))
        .all()
        .map(toPriceTable),
  };
}

/** Runs the engine has to finish off after a crash (FR-SYS-009). */
const ACTIVE_RUN_STATES = ['PREFLIGHT', 'RUNNING', 'PAUSED'];

export function createRunRepository(db: Db): RunRepository {
  return {
    create: async (scope: Scope, run: Run) => {
      db.insert(runs)
        .values({
          id: run.id,
          workspaceId: scope.workspaceId,
          workflowId: run.workflowId,
          projectId: run.projectId,
          status: run.status,
          haltReason: run.haltReason ?? null,
          // Written here and never in `update`: BR-04 makes the snapshot immutable.
          snapshot: toJsonColumn(run.snapshot, `run(${run.id}).snapshot`),
          inputs: toJsonColumn(run.inputs, `run(${run.id}).inputs`),
          preflightIssues: toJsonColumn(run.preflightIssues, `run(${run.id}).preflightIssues`),
          totals: toJsonColumn(run.totals, `run(${run.id}).totals`),
          startedAt: run.startedAt,
          endedAt: run.endedAt ?? null,
          durationMs: run.durationMs ?? null,
          finalOutput:
            run.finalOutput === undefined
              ? null
              : toJsonColumn(run.finalOutput, `run(${run.id}).finalOutput`),
          pausedAt: run.pausedAt ?? null,
          allowedActions:
            run.allowedActions === undefined
              ? null
              : toJsonColumn(run.allowedActions, `run(${run.id}).allowedActions`),
          budgetHalt:
            run.budgetHalt === undefined
              ? null
              : toJsonColumn(run.budgetHalt, `run(${run.id}).budgetHalt`),
          restartedFromRunId: run.restartedFromRunId ?? null,
          replayOf: run.replayOf ?? null,
          blockedReason: run.blockedReason ?? null,
          domain:
            run.domain === undefined ? null : toJsonColumn(run.domain, `run(${run.id}).domain`),
          goal: run.goal ?? null,
        })
        .run();
      return run;
    },

    get: async (scope: Scope, id: Id) => {
      const row = db
        .select()
        .from(runs)
        .where(and(eq(runs.workspaceId, scope.workspaceId), eq(runs.id, id)))
        .get();
      return row === undefined ? null : toRun(row);
    },

    listByWorkflow: async (scope: Scope, workflowId: Id, page: CursorQuery): Promise<Page<Run>> => {
      // Newest first (FR-EXE-012). Ids are monotonic ULIDs, so "newer" is "greater id" and the
      // cursor is just the last id of the previous page.
      const rows = db
        .select()
        .from(runs)
        .where(
          and(
            eq(runs.workspaceId, scope.workspaceId),
            eq(runs.workflowId, workflowId),
            page.cursor === undefined ? undefined : lt(runs.id, page.cursor),
          ),
        )
        .orderBy(desc(runs.id))
        .limit(page.limit + 1)
        .all();

      const items = rows.slice(0, page.limit).map(toRun);
      const nextCursor = rows.length > page.limit ? items.at(-1)?.id : undefined;

      return { items, ...(nextCursor === undefined ? {} : { nextCursor }) };
    },

    listActive: async (scope: Scope) =>
      db
        .select()
        .from(runs)
        .where(
          and(
            eq(runs.workspaceId, scope.workspaceId),
            // D305: a run BLOCKED mid-run is still going; one blocked at pre-flight has ended.
            or(
              inArray(runs.status, ACTIVE_RUN_STATES),
              and(eq(runs.status, 'BLOCKED'), isNotNull(runs.blockedReason)),
            ),
          ),
        )
        .orderBy(asc(runs.id))
        .all()
        .map(toRun),

    update: async (scope: Scope, id: Id, patch: RunPatch) => {
      const values = definedOnly({
        status: patch.status,
        haltReason: patch.haltReason,
        preflightIssues:
          patch.preflightIssues === undefined
            ? undefined
            : toJsonColumn(patch.preflightIssues, `run(${id}).preflightIssues`),
        totals:
          patch.totals === undefined ? undefined : toJsonColumn(patch.totals, `run(${id}).totals`),
        endedAt: patch.endedAt,
        durationMs: patch.durationMs,
        finalOutput:
          patch.finalOutput === undefined
            ? undefined
            : toJsonColumn(patch.finalOutput, `run(${id}).finalOutput`),
        // `null` reaches the column as NULL and removes the timestamp on a resume; `undefined` is
        // dropped by `definedOnly` and leaves it alone (D106, following D72).
        pausedAt: patch.pausedAt,
        allowedActions:
          patch.allowedActions === undefined
            ? undefined
            : toJsonColumn(patch.allowedActions, `run(${id}).allowedActions`),
        budgetHalt:
          patch.budgetHalt === undefined
            ? undefined
            : toJsonColumn(patch.budgetHalt, `run(${id}).budgetHalt`),
        restartedFromRunId: patch.restartedFromRunId,
        // `null` clears the reason on a resume (D305); `undefined` leaves it alone.
        blockedReason: patch.blockedReason,
        domain:
          patch.domain === undefined ? undefined : toJsonColumn(patch.domain, `run(${id}).domain`),
      });

      if (Object.keys(values).length > 0) {
        db.update(runs)
          .set(values)
          .where(and(eq(runs.workspaceId, scope.workspaceId), eq(runs.id, id)))
          .run();
      }

      const row = db
        .select()
        .from(runs)
        .where(and(eq(runs.workspaceId, scope.workspaceId), eq(runs.id, id)))
        .get();
      return row === undefined ? null : toRun(row);
    },
  };
}

/**
 * `NodeRunPatch` plus the round 5 fields (§2.2, §2.4, D233). The port's patch does not name them
 * yet — C5 made them optional on `NodeRun` — but the columns exist, so this adapter already
 * accepts them: once the engine records a node run's sources and memory ops, the port gains the
 * three lines and nothing here changes. `create` writes them today.
 */
export type SqliteNodeRunPatch = NodeRunPatch &
  Partial<Pick<NodeRun, 'sources' | 'droppedSources' | 'memoryOps'>>;

export function createNodeRunRepository(db: Db): NodeRunRepository {
  return {
    create: async (scope: Scope, nodeRun: NodeRun) => {
      const at = `nodeRun(${nodeRun.id})`;
      db.insert(nodeRuns)
        .values({
          id: nodeRun.id,
          workspaceId: scope.workspaceId,
          runId: nodeRun.runId,
          nodeId: nodeRun.nodeId,
          iteration: nodeRun.iteration,
          attempt: nodeRun.attempt,
          status: nodeRun.status,
          failureReason: nodeRun.failureReason ?? null,
          error: nodeRun.error === undefined ? null : toJsonColumn(nodeRun.error, `${at}.error`),
          modelUsed:
            nodeRun.modelUsed === undefined
              ? null
              : toJsonColumn(nodeRun.modelUsed, `${at}.modelUsed`),
          inputEnvelopes: toJsonColumn(nodeRun.inputEnvelopes, `${at}.inputEnvelopes`),
          output:
            nodeRun.output === undefined ? null : toJsonColumn(nodeRun.output, `${at}.output`),
          prompt:
            nodeRun.prompt === undefined ? null : toJsonColumn(nodeRun.prompt, `${at}.prompt`),
          usage: toJsonColumn(nodeRun.usage, `${at}.usage`),
          verdicts: toJsonColumn(nodeRun.verdicts, `${at}.verdicts`),
          toolCalls: toJsonColumn(nodeRun.toolCalls, `${at}.toolCalls`),
          approvals:
            nodeRun.approvals === undefined
              ? null
              : toJsonColumn(nodeRun.approvals, `${at}.approvals`),
          guardrailPolicy:
            nodeRun.guardrailPolicy === undefined
              ? null
              : toJsonColumn(nodeRun.guardrailPolicy, `${at}.guardrailPolicy`),
          loopStop: nodeRun.loopStop ?? null,
          reusedFromNodeRunId: nodeRun.reusedFromNodeRunId ?? null,
          trigger:
            nodeRun.trigger === undefined ? null : toJsonColumn(nodeRun.trigger, `${at}.trigger`),
          sources:
            nodeRun.sources === undefined ? null : toJsonColumn(nodeRun.sources, `${at}.sources`),
          droppedSources:
            nodeRun.droppedSources === undefined
              ? null
              : toJsonColumn(nodeRun.droppedSources, `${at}.droppedSources`),
          memoryOps:
            nodeRun.memoryOps === undefined
              ? null
              : toJsonColumn(nodeRun.memoryOps, `${at}.memoryOps`),
          startedAt: nodeRun.startedAt ?? null,
          endedAt: nodeRun.endedAt ?? null,
          durationMs: nodeRun.durationMs ?? null,
        })
        .run();
      return nodeRun;
    },

    get: async (scope: Scope, id: Id) => {
      const row = db
        .select()
        .from(nodeRuns)
        .where(and(eq(nodeRuns.workspaceId, scope.workspaceId), eq(nodeRuns.id, id)))
        .get();
      return row === undefined ? null : toNodeRun(row);
    },

    listByRun: async (scope: Scope, runId: Id) =>
      db
        .select()
        .from(nodeRuns)
        .where(and(eq(nodeRuns.workspaceId, scope.workspaceId), eq(nodeRuns.runId, runId)))
        .orderBy(asc(nodeRuns.id))
        .all()
        .map(toNodeRun),

    update: async (scope: Scope, id: Id, patch: SqliteNodeRunPatch) => {
      const at = `nodeRun(${id})`;
      const values = definedOnly({
        status: patch.status,
        failureReason: patch.failureReason,
        error: patch.error === undefined ? undefined : toJsonColumn(patch.error, `${at}.error`),
        modelUsed:
          patch.modelUsed === undefined
            ? undefined
            : toJsonColumn(patch.modelUsed, `${at}.modelUsed`),
        output: patch.output === undefined ? undefined : toJsonColumn(patch.output, `${at}.output`),
        prompt: patch.prompt === undefined ? undefined : toJsonColumn(patch.prompt, `${at}.prompt`),
        usage: patch.usage === undefined ? undefined : toJsonColumn(patch.usage, `${at}.usage`),
        guardrailPolicy:
          patch.guardrailPolicy === undefined
            ? undefined
            : toJsonColumn(patch.guardrailPolicy, `${at}.guardrailPolicy`),
        loopStop: patch.loopStop,
        reusedFromNodeRunId: patch.reusedFromNodeRunId,
        sources:
          patch.sources === undefined ? undefined : toJsonColumn(patch.sources, `${at}.sources`),
        droppedSources:
          patch.droppedSources === undefined
            ? undefined
            : toJsonColumn(patch.droppedSources, `${at}.droppedSources`),
        memoryOps:
          patch.memoryOps === undefined
            ? undefined
            : toJsonColumn(patch.memoryOps, `${at}.memoryOps`),
        inputEnvelopes:
          patch.inputEnvelopes === undefined
            ? undefined
            : toJsonColumn(patch.inputEnvelopes, `${at}.inputEnvelopes`),
        startedAt: patch.startedAt,
        endedAt: patch.endedAt,
        durationMs: patch.durationMs,
        trigger:
          patch.trigger === undefined ? undefined : toJsonColumn(patch.trigger, `${at}.trigger`),
      });

      if (Object.keys(values).length > 0) {
        db.update(nodeRuns)
          .set(values)
          .where(and(eq(nodeRuns.workspaceId, scope.workspaceId), eq(nodeRuns.id, id)))
          .run();
      }

      const row = db
        .select()
        .from(nodeRuns)
        .where(and(eq(nodeRuns.workspaceId, scope.workspaceId), eq(nodeRuns.id, id)))
        .get();
      return row === undefined ? null : toNodeRun(row);
    },

    /**
     * The day's spend for the `daily_budget` check (round 3 §2.3, FR-GRD-008).
     *
     * Summed in SQL over `json_extract(usage, '$.costUsd')`: the alternative is reading every node
     * run of the day into memory to add up one number of each. `started_at` is an ISO timestamp, so
     * a calendar day is a prefix match, and a node run that never started has no cost to count.
     */
    dailyCostUsd: async (scope: Scope, day: string) => {
      const row = db
        .select({
          total: sql<number>`COALESCE(SUM(json_extract(${nodeRuns.usage}, '$.costUsd')), 0)`,
        })
        .from(nodeRuns)
        .where(
          and(eq(nodeRuns.workspaceId, scope.workspaceId), like(nodeRuns.startedAt, `${day}%`)),
        )
        .get();
      return row?.total ?? 0;
    },
  };
}
