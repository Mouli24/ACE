import { randomInt } from 'node:crypto';

import {
  BENCH_ARMS,
  BenchLabelSchema,
  allowedRunActions,
  benchOutcome,
  type BenchArm,
  type BenchArmReport,
  type BenchExperiment,
  type BenchModelRef,
  type BenchReport,
  type BenchRun,
  type BenchRunRecord,
  type BenchScore,
  type BenchTask,
  type BenchTaskReport,
  type BlindExport,
  type CreateBenchExperimentRequest,
  type CreateBenchTaskRequest,
  type Id,
  type ImportBenchScoresRequest,
  type ImportBenchScoresResponse,
  type ModelUsed,
  type NodeApprovalDecidedPayload,
  type NodeApprovalRequiredPayload,
  type Part,
  type Run,
  type RunCompletedPayload,
  type RunSnapshot,
  type UpdateBenchExperimentRequest,
  type UpdateBenchTaskRequest,
} from '@ace/contracts';

import type { EventBus } from '../events/index.js';
import { HttpError, notFound, validationFailed } from '../gateway/errors.js';
import { newId } from '../ids.js';
import type { Logger } from '../logging/index.js';
import type {
  BenchRepository,
  Repository,
  Scope,
  StoredBenchExperiment,
  StoredBenchRun,
  StoredBenchScore,
  Unsubscribe,
} from '../ports/index.js';
import type { RunService } from '../runs/index.js';
import {
  baselineSnapshot,
  canonicalJson,
  forceFixedRouting,
  runInputsFor,
  sha256,
  strongestModel,
  taskContentHash,
} from './baseline.js';

/**
 * ACE Bench (PG-5.6, FR-BEN-001..008, `docs/team-prompts/ace-bench-plan.md`).
 *
 * - Tasks are drafts until frozen; freezing stores the SHA-256 of their canonical JSON and every
 *   edit after it is refused (FR-BEN-002, TC-BEN-001).
 * - An experiment lists every planned run up front — tasks × arms × repetitions (FR-BEN-003) — and
 *   its pre-registered rules lock at start (FR-BEN-007, TC-BEN-006).
 * - Start snapshots arm A's workflow once, builds arm B in memory, and drives the runs **one at a
 *   time** through the normal run service — guardrails, budgets, approvals and the event log all
 *   apply — with routing forced Fixed. An approval request pauses the experiment until the person
 *   answers it; the bench never answers one.
 * - Each finished run's record (FR-BEN-004) is written once; outputs are exported blind under random
 *   labels whose key stays here (FR-BEN-005); imported scores link back through it (FR-BEN-006);
 *   the report applies the locked threshold on read.
 * - A bench run is a normal `runs` row carrying `benchExperimentId`, which keeps it out of the run
 *   history, the timeline and Domain (FR-BEN-008).
 */

export interface BenchService {
  listTasks(): Promise<BenchTask[]>;
  getTask(id: Id): Promise<BenchTask>;
  createTask(body: CreateBenchTaskRequest): Promise<BenchTask>;
  updateTask(id: Id, body: UpdateBenchTaskRequest): Promise<BenchTask>;
  freezeTask(id: Id): Promise<BenchTask>;

  listExperiments(): Promise<BenchExperiment[]>;
  getExperiment(id: Id): Promise<BenchExperiment>;
  createExperiment(body: CreateBenchExperimentRequest): Promise<BenchExperiment>;
  updateExperiment(id: Id, body: UpdateBenchExperimentRequest): Promise<BenchExperiment>;
  /** Locks the rules and queues the runs; answers once the queue is going. */
  startExperiment(id: Id): Promise<BenchExperiment>;

  blindExport(id: Id): Promise<BlindExport>;
  importScores(id: Id, body: ImportBenchScoresRequest): Promise<ImportBenchScoresResponse>;
  report(id: Id): Promise<BenchReport>;

  /** Subscribe to the bus (run ends, approvals) and mark experiments a stopped engine left. */
  start(): Promise<void>;
  /** Detach from the bus; the queue in flight stops after its current run. */
  stop(): Promise<void>;
}

export interface BenchServiceDeps {
  bench: BenchRepository;
  repository: Repository;
  scope: Scope;
  bus: EventBus;
  logger: Logger;
  runs: Pick<RunService, 'driveRecordedRun'>;
  /** The engine build every record names (FR-BEN-004). */
  buildVersion: string;
  now?: () => string;
  nextId?: () => Id;
}

const benchTaskFrozen = (id: Id): HttpError =>
  new HttpError(
    'invalid_config',
    'bench_task_frozen',
    `Bench task ${id} is frozen; a frozen task cannot be changed.`,
    { taskId: id },
  );

const benchTaskNotFrozen = (ids: Id[]): HttpError =>
  new HttpError(
    'invalid_config',
    'bench_task_not_frozen',
    'An experiment measures frozen tasks only; freeze these first.',
    { taskIds: ids },
  );

const benchExperimentLocked = (id: Id): HttpError =>
  new HttpError(
    'invalid_config',
    'bench_experiment_locked',
    `Experiment ${id} has started; its rules and plan are locked.`,
    { experimentId: id },
  );

/** Label alphabet: no 0/O or 1/I, so a judge copying labels by hand cannot confuse them. */
const LABEL_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomLabel(): string {
  let label = '';
  for (let i = 0; i < 8; i += 1) label += LABEL_ALPHABET[randomInt(LABEL_ALPHABET.length)];
  return label;
}

function shuffle<T>(items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** A CSV with a `label,score[,note]` header; quoted fields may hold commas, quotes and newlines. */
export function parseScoresCsv(csv: string): { rows: BenchScore[]; invalid: string[] } {
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let quoted = false;
  for (let i = 0; i < csv.length; i += 1) {
    const char = csv[i]!;
    if (quoted) {
      if (char === '"' && csv[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      record.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && csv[i + 1] === '\n') i += 1;
      record.push(field);
      records.push(record);
      record = [];
      field = '';
    } else field += char;
  }
  if (field !== '' || record.length > 0) {
    record.push(field);
    records.push(record);
  }

  const nonEmpty = records.filter((row) => row.some((cell) => cell.trim() !== ''));
  const header = (nonEmpty[0] ?? []).map((cell) => cell.trim().toLowerCase());
  const labelAt = header.indexOf('label');
  const scoreAt = header.indexOf('score');
  const noteAt = header.indexOf('note');
  if (labelAt === -1 || scoreAt === -1) {
    throw validationFailed('The scores CSV needs a header row naming "label" and "score".', []);
  }

  const rows: BenchScore[] = [];
  const invalid: string[] = [];
  for (const row of nonEmpty.slice(1)) {
    const label = (row[labelAt] ?? '').trim();
    const score = Number((row[scoreAt] ?? '').trim());
    const note = noteAt === -1 ? undefined : (row[noteAt] ?? '').trim();
    if (!BenchLabelSchema.safeParse(label).success || (row[scoreAt] ?? '').trim() === '') {
      invalid.push(label);
      continue;
    }
    if (!Number.isFinite(score)) {
      invalid.push(label);
      continue;
    }
    rows.push({ label, score, ...(note === undefined || note === '' ? {} : { note }) });
  }
  return { rows, invalid };
}

export function createBenchService(deps: BenchServiceDeps): BenchService {
  const { bench, repository, scope, bus, logger } = deps;
  const now = deps.now ?? (() => new Date().toISOString());
  const nextId = deps.nextId ?? newId;
  const log = logger.child({ subsystem: 'bench' });

  /** runId → resolve, for the run the queue is waiting on. */
  const waiting = new Map<Id, () => void>();
  /** runId → the bench run and experiment it belongs to, while it is in flight. */
  const inFlight = new Map<Id, { experimentId: Id; benchRunId: Id }>();
  let unsubscribe: Unsubscribe | undefined;
  let stopping = false;

  /* ------------------------------------------------------------------ reads */

  async function task(id: Id): Promise<BenchTask> {
    const found = await bench.getTask(scope, id);
    if (found === null) throw notFound(`Bench task ${id}`);
    return found;
  }

  async function stored(id: Id): Promise<StoredBenchExperiment> {
    const found = await bench.getExperiment(scope, id);
    if (found === null) throw notFound(`Experiment ${id}`);
    return found;
  }

  async function assemble(experiment: StoredBenchExperiment): Promise<BenchExperiment> {
    const [runs, scores] = await Promise.all([
      bench.listRuns(scope, experiment.id),
      bench.listScores(scope, experiment.id),
    ]);
    const scoreOf = new Map(scores.map((score) => [score.benchRunId, score]));
    return {
      ...experiment,
      runs: runs.map(({ run }): BenchRun => {
        const score = scoreOf.get(run.id);
        return {
          ...run,
          ...(score === undefined ? {} : { score: score.score }),
          ...(score?.note === undefined ? {} : { scoreNote: score.note }),
        };
      }),
    };
  }

  async function frozenTasks(ids: readonly Id[]): Promise<BenchTask[]> {
    const tasks = await Promise.all(ids.map((id) => task(id)));
    const drafts = tasks.filter((candidate) => candidate.status !== 'frozen').map((t) => t.id);
    if (drafts.length > 0) throw benchTaskNotFrozen(drafts);
    return tasks;
  }

  /**
   * Every planned run, in queue order: task by task, repetition by repetition, the two arms
   * back to back — so drift in a provider over the experiment's length lands on both arms alike.
   */
  function plan(experimentId: Id, taskIds: readonly Id[], repetitions: number): StoredBenchRun[] {
    const runs: StoredBenchRun[] = [];
    for (const taskId of taskIds) {
      for (let rep = 1; rep <= repetitions; rep += 1) {
        for (const arm of BENCH_ARMS) {
          runs.push({
            run: {
              id: nextId(),
              experimentId,
              taskId,
              arm,
              rep,
              order: runs.length,
              status: 'planned',
            },
          });
        }
      }
    }
    return runs;
  }

  async function armASnapshot(workflowId: Id): Promise<RunSnapshot> {
    const workflow = await repository.workflows.get(scope, workflowId);
    if (workflow === null) throw notFound(`Workflow ${workflowId}`);
    const [nodes, edges] = await Promise.all([
      repository.nodes.listByWorkflow(scope, workflowId),
      repository.edges.listByWorkflow(scope, workflowId),
    ]);
    return { version: workflow.version, nodes, edges };
  }

  async function defaultBaseline(workflowId: Id): Promise<BenchModelRef | undefined> {
    const snapshot = await armASnapshot(workflowId);
    return strongestModel(snapshot.nodes, await repository.models.list(scope, {}));
  }

  async function setExperiment(
    experiment: StoredBenchExperiment,
    patch: Partial<Omit<StoredBenchExperiment, 'pendingApproval'>> & {
      /** `null` clears it. */
      pendingApproval?: StoredBenchExperiment['pendingApproval'] | null;
    },
  ): Promise<StoredBenchExperiment> {
    const { pendingApproval, ...rest } = patch;
    const { pendingApproval: _previous, ...base } = experiment;
    const keep =
      pendingApproval === null ? undefined : (pendingApproval ?? experiment.pendingApproval);
    const next: StoredBenchExperiment = {
      ...base,
      ...rest,
      ...(keep === undefined ? {} : { pendingApproval: keep }),
      updatedAt: now(),
    };
    return bench.putExperiment(scope, next);
  }

  /* ------------------------------------------------------------- the queue */

  /** What a finished run recorded (FR-BEN-004). */
  async function recordOf(run: Run): Promise<BenchRunRecord> {
    const nodeRuns = await repository.nodeRuns.listByRun(scope, run.id);
    const models: ModelUsed[] = [];
    const seen = new Set<string>();
    for (const nodeRun of nodeRuns) {
      const used = nodeRun.modelUsed;
      if (used === undefined) continue;
      const key = `${used.providerId}\u0000${used.modelId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      models.push(used);
    }
    const outputOrder = run.snapshot.nodes.filter((node) => node.kind === 'output');
    const output: Part[] = outputOrder.flatMap((node) => run.finalOutput?.[node.id] ?? []);
    const durationMs =
      run.durationMs ??
      (run.endedAt === undefined
        ? 0
        : Math.max(0, Date.parse(run.endedAt) - Date.parse(run.startedAt)));
    return {
      runStatus: run.status,
      ...(run.haltReason === undefined ? {} : { haltReason: run.haltReason }),
      output,
      usage: run.totals,
      durationMs,
      models,
      workflowSnapshot: {
        version: run.snapshot.version,
        hash: sha256(canonicalJson(run.snapshot)),
        nodeCount: run.snapshot.nodes.length,
      },
      prompts: nodeRuns.flatMap((nodeRun) =>
        nodeRun.prompt === undefined
          ? []
          : [
              {
                nodeId: nodeRun.nodeId,
                version: nodeRun.prompt.version,
                textHash: sha256(nodeRun.prompt.text),
              },
            ],
      ),
      buildVersion: deps.buildVersion,
    };
  }

  /** Records one bench run as an ordinary run row, drives it, and waits for it to end. */
  async function runOne(
    experiment: StoredBenchExperiment,
    planned: StoredBenchRun,
    snapshots: Record<BenchArm, RunSnapshot>,
    tasks: Map<Id, BenchTask>,
  ): Promise<void> {
    const benchTask = tasks.get(planned.run.taskId);
    if (benchTask === undefined) throw notFound(`Bench task ${planned.run.taskId}`);
    const snapshot = snapshots[planned.run.arm];

    const run: Run = {
      id: nextId(),
      workflowId: experiment.workflowId,
      projectId: experiment.projectId,
      status: 'PREFLIGHT',
      allowedActions: allowedRunActions('PREFLIGHT'),
      snapshot,
      inputs: runInputsFor(snapshot, benchTask),
      preflightIssues: [],
      totals: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
      startedAt: now(),
      benchExperimentId: experiment.id,
    };
    await repository.runs.create(scope, run);

    await bench.putRun(scope, {
      ...planned,
      run: { ...planned.run, status: 'running', runId: run.id },
    });
    inFlight.set(run.id, { experimentId: experiment.id, benchRunId: planned.run.id });

    // Registered before the run is driven: a run BLOCKED at pre-flight ends inside the call.
    const ended = new Promise<void>((resolve) => waiting.set(run.id, resolve));
    try {
      await deps.runs.driveRecordedRun(run);
      await ended;
    } finally {
      waiting.delete(run.id);
      inFlight.delete(run.id);
    }

    const finished = (await repository.runs.get(scope, run.id)) ?? run;
    await bench.putRun(scope, {
      ...planned,
      run: { ...planned.run, status: 'done', runId: run.id, record: await recordOf(finished) },
    });
  }

  async function drive(experimentId: Id, snapshots: Record<BenchArm, RunSnapshot>): Promise<void> {
    const experiment = await stored(experimentId);
    const tasks = new Map(
      (await Promise.all(experiment.taskIds.map((id) => task(id)))).map((t) => [t.id, t]),
    );
    for (const planned of await bench.listRuns(scope, experimentId)) {
      if (planned.run.status !== 'planned') continue;
      if (stopping) return;
      await runOne(await stored(experimentId), planned, snapshots, tasks);
    }
    await setExperiment(await stored(experimentId), {
      status: 'complete',
      endedAt: now(),
      pendingApproval: null,
    });
    log.info({ experimentId }, 'bench experiment complete');
  }

  /* ----------------------------------------------------------------- events */

  async function onApproval(runId: Id, nodeRunId: Id | undefined, required: boolean) {
    const link = inFlight.get(runId);
    if (link === undefined) return;
    const experiment = await bench.getExperiment(scope, link.experimentId);
    if (experiment === null) return;
    const planned = (await bench.listRuns(scope, link.experimentId)).find(
      (candidate) => candidate.run.id === link.benchRunId,
    );
    if (required && nodeRunId !== undefined) {
      await setExperiment(experiment, {
        status: 'waiting_approval',
        pendingApproval: { runId, nodeRunId },
      });
      if (planned !== undefined)
        await bench.putRun(scope, {
          ...planned,
          run: { ...planned.run, status: 'waiting_approval' },
        });
    } else if (experiment.status === 'waiting_approval') {
      await setExperiment(experiment, { status: 'running', pendingApproval: null });
      if (planned !== undefined)
        await bench.putRun(scope, { ...planned, run: { ...planned.run, status: 'running' } });
    }
  }

  /* ---------------------------------------------------------------- service */

  const service: BenchService = {
    listTasks: () => bench.listTasks(scope),
    getTask: (id) => task(id),

    async createTask(body) {
      const at = now();
      return bench.putTask(scope, {
        id: nextId(),
        name: body.name,
        prompt: body.prompt.trim(),
        inputs: body.inputs ?? [],
        rubric: body.rubric ?? '',
        status: 'draft',
        createdAt: at,
        updatedAt: at,
      });
    },

    async updateTask(id, body) {
      const current = await task(id);
      if (current.status === 'frozen') throw benchTaskFrozen(id);
      return bench.putTask(scope, {
        ...current,
        ...(body.name === undefined ? {} : { name: body.name }),
        ...(body.prompt === undefined ? {} : { prompt: body.prompt.trim() }),
        ...(body.inputs === undefined ? {} : { inputs: body.inputs }),
        ...(body.rubric === undefined ? {} : { rubric: body.rubric }),
        updatedAt: now(),
      });
    },

    async freezeTask(id) {
      const current = await task(id);
      if (current.status === 'frozen') throw benchTaskFrozen(id);
      const at = now();
      return bench.putTask(scope, {
        ...current,
        status: 'frozen',
        contentHash: taskContentHash(current),
        frozenAt: at,
        updatedAt: at,
      });
    },

    async listExperiments() {
      return Promise.all((await bench.listExperiments(scope)).map(assemble));
    },

    async getExperiment(id) {
      return assemble(await stored(id));
    },

    async createExperiment(body) {
      const workflow = await repository.workflows.get(scope, body.workflowId);
      if (workflow === null) throw notFound(`Workflow ${body.workflowId}`);
      const taskIds = [...new Set(body.taskIds)];
      await frozenTasks(taskIds);
      const baselineModel = body.baselineModel ?? (await defaultBaseline(body.workflowId));

      const at = now();
      const experiment: StoredBenchExperiment = {
        id: nextId(),
        name: body.name,
        workflowId: workflow.id,
        projectId: workflow.projectId,
        taskIds,
        repetitions: body.repetitions,
        ...(baselineModel === undefined ? {} : { baselineModel }),
        rules: body.rules,
        status: 'draft',
        createdAt: at,
        updatedAt: at,
      };
      await bench.putExperiment(scope, experiment);
      await bench.replaceRuns(scope, experiment.id, plan(experiment.id, taskIds, body.repetitions));
      return assemble(experiment);
    },

    async updateExperiment(id, body) {
      const current = await stored(id);
      // FR-BEN-007, TC-BEN-006: after start the rules — and everything else — are locked.
      if (current.status !== 'draft') throw benchExperimentLocked(id);
      const taskIds = body.taskIds === undefined ? undefined : [...new Set(body.taskIds)];
      if (taskIds !== undefined) await frozenTasks(taskIds);

      const next = await setExperiment(current, {
        ...(body.name === undefined ? {} : { name: body.name }),
        ...(taskIds === undefined ? {} : { taskIds }),
        ...(body.repetitions === undefined ? {} : { repetitions: body.repetitions }),
        ...(body.baselineModel === undefined ? {} : { baselineModel: body.baselineModel }),
        ...(body.rules === undefined ? {} : { rules: body.rules }),
      });
      if (taskIds !== undefined || body.repetitions !== undefined) {
        await bench.replaceRuns(scope, id, plan(id, next.taskIds, next.repetitions));
      }
      return assemble(next);
    },

    async startExperiment(id) {
      const current = await stored(id);
      if (current.status !== 'draft') throw benchExperimentLocked(id);
      const tasks = await frozenTasks(current.taskIds);
      if (current.baselineModel === undefined) {
        throw validationFailed(
          'Arm B needs a model: the workflow names none, so choose one before starting.',
          [],
        );
      }

      // Arm A is snapshotted once, here, and every one of its runs executes this snapshot (BR-04).
      const live = await armASnapshot(current.workflowId);
      const armA: RunSnapshot = { ...live, nodes: forceFixedRouting(live.nodes) };
      const armB = baselineSnapshot({
        armA,
        tasks,
        model: current.baselineModel,
        workflowId: current.workflowId,
        newId: nextId,
      });

      const started = await setExperiment(current, { status: 'running', startedAt: now() });
      log.info({ experimentId: id }, 'bench experiment started');

      void drive(id, { workflow: armA, baseline: armB }).catch(async (error: unknown) => {
        log.error({ experimentId: id, err: error }, 'bench experiment stopped on an error');
        const latest = await bench.getExperiment(scope, id);
        if (latest !== null) {
          await setExperiment(latest, {
            status: 'interrupted',
            endedAt: now(),
            pendingApproval: null,
          });
        }
      });
      return assemble(started);
    },

    async blindExport(id) {
      const experiment = await stored(id);
      const runs = await bench.listRuns(scope, id);
      const tasks = await Promise.all(experiment.taskIds.map((taskId) => task(taskId)));

      // Labels are given once and kept: exporting again shows the judge the same label per output.
      const used = new Set(runs.flatMap((candidate) => candidate.label ?? []));
      const items: BlindExport['items'] = [];
      for (const candidate of runs) {
        const record = candidate.run.record;
        if (candidate.run.status !== 'done' || record === undefined || record.output.length === 0)
          continue;
        let label = candidate.label;
        if (label === undefined) {
          do label = randomLabel();
          while (used.has(label));
          used.add(label);
          await bench.putRun(scope, { ...candidate, label });
        }
        items.push({ label, taskId: candidate.run.taskId, output: record.output });
      }

      return {
        exportedAt: now(),
        experimentName: experiment.name,
        tasks: tasks.map((t) => ({
          taskId: t.id,
          name: t.name,
          prompt: t.prompt,
          inputs: t.inputs,
          rubric: t.rubric,
        })),
        items: shuffle(items),
      };
    },

    async importScores(id, body) {
      await stored(id);
      const parsed =
        'scores' in body
          ? { rows: body.scores, invalid: [] as string[] }
          : parseScoresCsv(body.csv);
      const byLabel = new Map(
        (await bench.listRuns(scope, id)).flatMap((candidate) =>
          candidate.label === undefined ? [] : [[candidate.label, candidate] as const],
        ),
      );

      const unknownLabels = [...parsed.invalid];
      let imported = 0;
      const at = now();
      for (const row of parsed.rows) {
        const candidate = byLabel.get(row.label);
        if (candidate === undefined) {
          unknownLabels.push(row.label);
          continue;
        }
        const score: StoredBenchScore = {
          benchRunId: candidate.run.id,
          experimentId: id,
          label: row.label,
          score: row.score,
          ...(row.note === undefined ? {} : { note: row.note }),
          importedAt: at,
        };
        await bench.putScore(scope, score);
        imported += 1;
      }
      return { imported, unknownLabels };
    },

    async report(id) {
      const experiment = await assemble(await stored(id));
      const tasks = await Promise.all(experiment.taskIds.map((taskId) => task(taskId)));
      const summary = { win: 0, partial: 0, loss: 0, pending: 0 };

      const taskReports = tasks.map((t): BenchTaskReport => {
        const arms = BENCH_ARMS.map((arm): BenchArmReport => {
          const runs = experiment.runs.filter((run) => run.taskId === t.id && run.arm === arm);
          const finished = runs.filter((run) => run.record !== undefined);
          const scored = runs.filter((run) => run.score !== undefined);
          const sum = (pick: (record: BenchRunRecord) => number) =>
            finished.reduce((total, run) => total + pick(run.record!), 0);
          return {
            arm,
            runs: runs.length,
            scored: scored.length,
            ...(scored.length === 0
              ? {}
              : {
                  meanScore: scored.reduce((total, run) => total + run.score!, 0) / scored.length,
                }),
            tokensIn: sum((record) => record.usage.tokensIn),
            tokensOut: sum((record) => record.usage.tokensOut),
            costUsd: sum((record) => record.usage.costUsd),
            ...(finished.length === 0
              ? {}
              : { meanDurationMs: sum((record) => record.durationMs) / finished.length }),
          };
        });

        const workflow = arms.find((arm) => arm.arm === 'workflow')?.meanScore;
        const baseline = arms.find((arm) => arm.arm === 'baseline')?.meanScore;
        if (workflow === undefined || baseline === undefined) {
          summary.pending += 1;
          return { taskId: t.id, taskName: t.name, arms };
        }
        const outcome = benchOutcome(workflow, baseline, experiment.rules.threshold);
        summary[outcome] += 1;
        return {
          taskId: t.id,
          taskName: t.name,
          arms,
          difference: workflow - baseline,
          outcome,
        };
      });

      return {
        experimentId: experiment.id,
        generatedAt: now(),
        rules: experiment.rules,
        ...(experiment.baselineModel === undefined
          ? {}
          : { baselineModel: experiment.baselineModel }),
        tasks: taskReports,
        summary,
      };
    },

    async start() {
      stopping = false;
      unsubscribe = await bus.subscribe((event) => {
        if (event.runId === undefined) return;
        if (event.type === 'run.completed') {
          const payload = event.payload as RunCompletedPayload;
          waiting.get(payload.runId)?.();
          return;
        }
        if (event.type === 'node.approval_required') {
          const payload = event.payload as NodeApprovalRequiredPayload;
          void onApproval(payload.runId, payload.request.nodeRunId, true).catch((error: unknown) =>
            log.warn({ err: error }, 'bench could not record an approval request'),
          );
          return;
        }
        if (event.type === 'node.approval_decided') {
          const payload = event.payload as NodeApprovalDecidedPayload;
          void onApproval(payload.runId, payload.nodeRunId, false).catch((error: unknown) =>
            log.warn({ err: error }, 'bench could not record an approval decision'),
          );
        }
      });

      // An experiment a stopped engine left mid-queue does not resume: its run was halted by crash
      // recovery, and a bench measured across two engine processes is not one measurement.
      for (const experiment of await bench.listExperiments(scope)) {
        if (experiment.status !== 'running' && experiment.status !== 'waiting_approval') continue;
        for (const planned of await bench.listRuns(scope, experiment.id)) {
          if (planned.run.status === 'done') continue;
          await bench.putRun(scope, { ...planned, run: { ...planned.run, status: 'skipped' } });
        }
        await setExperiment(experiment, {
          status: 'interrupted',
          endedAt: now(),
          pendingApproval: null,
        });
        log.warn({ experimentId: experiment.id }, 'bench experiment interrupted by a restart');
      }
    },

    async stop() {
      stopping = true;
      unsubscribe?.();
      unsubscribe = undefined;
      for (const resolve of waiting.values()) resolve();
    },
  };

  return service;
}
