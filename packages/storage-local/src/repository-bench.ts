import {
  BenchArmSchema,
  BenchExperimentStatusSchema,
  BenchRunRecordSchema,
  BenchRunStatusSchema,
  BenchTaskSchema,
  type BenchTask,
  type Id,
} from '@ace/contracts';
import type {
  BenchRepository,
  Scope,
  StoredBenchExperiment,
  StoredBenchRun,
  StoredBenchScore,
} from '@ace/engine';
import { and, asc, desc, eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import type * as schema from './schema.js';
import { benchExperiments, benchRuns, benchScores, benchTasks } from './schema.js';
import { toJsonColumn } from './secret-guard.js';

type Db = BetterSQLite3Database<typeof schema>;
type TaskRow = typeof benchTasks.$inferSelect;
type ExperimentRow = typeof benchExperiments.$inferSelect;
type RunRow = typeof benchRuns.$inferSelect;
type ScoreRow = typeof benchScores.$inferSelect;

/*
 * ACE Bench (PG-5.6, FR-BEN-001..008). Whole-row upserts: the bench service owns every rule about
 * what may change when. JSON columns go through `toJsonColumn`, so the secret guard sees them too.
 */

function toTask(row: TaskRow): BenchTask {
  return BenchTaskSchema.parse({
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    inputs: JSON.parse(row.inputs),
    rubric: row.rubric,
    status: row.status,
    ...(row.contentHash === null ? {} : { contentHash: row.contentHash }),
    ...(row.frozenAt === null ? {} : { frozenAt: row.frozenAt }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function toExperiment(row: ExperimentRow): StoredBenchExperiment {
  return {
    id: row.id,
    name: row.name,
    workflowId: row.workflowId,
    projectId: row.projectId,
    taskIds: JSON.parse(row.taskIds),
    repetitions: row.repetitions,
    ...(row.baselineModel === null ? {} : { baselineModel: JSON.parse(row.baselineModel) }),
    rules: JSON.parse(row.rules),
    status: BenchExperimentStatusSchema.parse(row.status),
    ...(row.pendingApproval === null ? {} : { pendingApproval: JSON.parse(row.pendingApproval) }),
    ...(row.startedAt === null ? {} : { startedAt: row.startedAt }),
    ...(row.endedAt === null ? {} : { endedAt: row.endedAt }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toRun(row: RunRow): StoredBenchRun {
  return {
    run: {
      id: row.id,
      experimentId: row.experimentId,
      taskId: row.taskId,
      arm: BenchArmSchema.parse(row.arm),
      rep: row.rep,
      order: row.ord,
      status: BenchRunStatusSchema.parse(row.status),
      ...(row.runId === null ? {} : { runId: row.runId }),
      ...(row.record === null
        ? {}
        : { record: BenchRunRecordSchema.parse(JSON.parse(row.record)) }),
    },
    ...(row.label === null ? {} : { label: row.label }),
  };
}

function toScore(row: ScoreRow): StoredBenchScore {
  return {
    benchRunId: row.benchRunId,
    experimentId: row.experimentId,
    label: row.label,
    score: row.score,
    ...(row.note === null ? {} : { note: row.note }),
    importedAt: row.importedAt,
  };
}

function runValues(scope: Scope, stored: StoredBenchRun) {
  const { run } = stored;
  return {
    id: run.id,
    workspaceId: scope.workspaceId,
    experimentId: run.experimentId,
    taskId: run.taskId,
    arm: run.arm,
    rep: run.rep,
    ord: run.order,
    status: run.status,
    runId: run.runId ?? null,
    record:
      run.record === undefined ? null : toJsonColumn(run.record, `benchRun(${run.id}).record`),
    label: stored.label ?? null,
  };
}

export function createBenchRepository(db: Db): BenchRepository {
  const taskWhere = (scope: Scope, id: Id) =>
    and(eq(benchTasks.workspaceId, scope.workspaceId), eq(benchTasks.id, id));
  const experimentWhere = (scope: Scope, id: Id) =>
    and(eq(benchExperiments.workspaceId, scope.workspaceId), eq(benchExperiments.id, id));

  return {
    putTask: async (scope, task) => {
      const at = `benchTask(${task.id})`;
      const values = {
        id: task.id,
        workspaceId: scope.workspaceId,
        name: task.name,
        prompt: task.prompt,
        inputs: toJsonColumn(task.inputs, `${at}.inputs`),
        rubric: task.rubric,
        status: task.status,
        contentHash: task.contentHash ?? null,
        frozenAt: task.frozenAt ?? null,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      };
      const { id: _id, workspaceId: _ws, ...set } = values;
      db.insert(benchTasks).values(values).onConflictDoUpdate({ target: benchTasks.id, set }).run();
      return task;
    },

    getTask: async (scope, id) => {
      const row = db.select().from(benchTasks).where(taskWhere(scope, id)).get();
      return row === undefined ? null : toTask(row);
    },

    listTasks: async (scope) =>
      db
        .select()
        .from(benchTasks)
        .where(eq(benchTasks.workspaceId, scope.workspaceId))
        .orderBy(desc(benchTasks.id))
        .all()
        .map(toTask),

    putExperiment: async (scope, experiment) => {
      const at = `benchExperiment(${experiment.id})`;
      const values = {
        id: experiment.id,
        workspaceId: scope.workspaceId,
        name: experiment.name,
        workflowId: experiment.workflowId,
        projectId: experiment.projectId,
        taskIds: toJsonColumn(experiment.taskIds, `${at}.taskIds`),
        repetitions: experiment.repetitions,
        baselineModel:
          experiment.baselineModel === undefined
            ? null
            : toJsonColumn(experiment.baselineModel, `${at}.baselineModel`),
        rules: toJsonColumn(experiment.rules, `${at}.rules`),
        status: experiment.status,
        pendingApproval:
          experiment.pendingApproval === undefined
            ? null
            : toJsonColumn(experiment.pendingApproval, `${at}.pendingApproval`),
        startedAt: experiment.startedAt ?? null,
        endedAt: experiment.endedAt ?? null,
        createdAt: experiment.createdAt,
        updatedAt: experiment.updatedAt,
      };
      const { id: _id, workspaceId: _ws, ...set } = values;
      db.insert(benchExperiments)
        .values(values)
        .onConflictDoUpdate({ target: benchExperiments.id, set })
        .run();
      return experiment;
    },

    getExperiment: async (scope, id) => {
      const row = db.select().from(benchExperiments).where(experimentWhere(scope, id)).get();
      return row === undefined ? null : toExperiment(row);
    },

    listExperiments: async (scope) =>
      db
        .select()
        .from(benchExperiments)
        .where(eq(benchExperiments.workspaceId, scope.workspaceId))
        .orderBy(desc(benchExperiments.id))
        .all()
        .map(toExperiment),

    replaceRuns: async (scope, experimentId, runs) => {
      // The delete and the inserts commit together. Never called inside a repository transaction.
      db.transaction((tx) => {
        tx.delete(benchRuns)
          .where(
            and(
              eq(benchRuns.workspaceId, scope.workspaceId),
              eq(benchRuns.experimentId, experimentId),
            ),
          )
          .run();
        for (const stored of runs) tx.insert(benchRuns).values(runValues(scope, stored)).run();
      });
    },

    putRun: async (scope, stored) => {
      const values = runValues(scope, stored);
      const { id: _id, workspaceId: _ws, ...set } = values;
      db.insert(benchRuns).values(values).onConflictDoUpdate({ target: benchRuns.id, set }).run();
    },

    listRuns: async (scope, experimentId) =>
      db
        .select()
        .from(benchRuns)
        .where(
          and(
            eq(benchRuns.workspaceId, scope.workspaceId),
            eq(benchRuns.experimentId, experimentId),
          ),
        )
        .orderBy(asc(benchRuns.ord))
        .all()
        .map(toRun),

    putScore: async (scope, score) => {
      const values = {
        benchRunId: score.benchRunId,
        workspaceId: scope.workspaceId,
        experimentId: score.experimentId,
        label: score.label,
        score: score.score,
        note: score.note ?? null,
        importedAt: score.importedAt,
      };
      const { benchRunId: _id, workspaceId: _ws, ...set } = values;
      db.insert(benchScores)
        .values(values)
        .onConflictDoUpdate({ target: benchScores.benchRunId, set })
        .run();
    },

    listScores: async (scope, experimentId) =>
      db
        .select()
        .from(benchScores)
        .where(
          and(
            eq(benchScores.workspaceId, scope.workspaceId),
            eq(benchScores.experimentId, experimentId),
          ),
        )
        .all()
        .map(toScore),
  };
}
