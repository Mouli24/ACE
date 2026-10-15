import type { BenchExperiment, BenchRun, BenchTask, Id, Timestamp } from '@ace/contracts';

import type { Scope } from './scope.js';

/**
 * ACE Bench's store (PG-5.6, FR-BEN-001..008): tasks, experiments, their planned runs and the
 * judge's scores. Four tables locally (`bench_tasks`, `bench_experiments`, `bench_runs`,
 * `bench_scores`); the runs themselves are ordinary `runs` rows carrying `benchExperimentId`.
 *
 * Writes are whole-row upserts: the bench service owns every rule about what may change when (a
 * frozen task, a started experiment), so the store only keeps what it is given.
 */

/** An experiment as stored: its planned runs live in their own table. */
export type StoredBenchExperiment = Omit<BenchExperiment, 'runs'>;

/**
 * A planned run as stored. `label` is the blind label it was exported under — the label → run key
 * that never leaves the engine (FR-BEN-005). The score is joined from `bench_scores`.
 */
export interface StoredBenchRun {
  run: Omit<BenchRun, 'score' | 'scoreNote'>;
  label?: string;
}

/** One imported score, linked to its run through the kept label (FR-BEN-006). */
export interface StoredBenchScore {
  benchRunId: Id;
  experimentId: Id;
  label: string;
  score: number;
  note?: string;
  importedAt: Timestamp;
}

export interface BenchRepository {
  putTask(scope: Scope, task: BenchTask): Promise<BenchTask>;
  getTask(scope: Scope, id: Id): Promise<BenchTask | null>;
  /** Newest first. */
  listTasks(scope: Scope): Promise<BenchTask[]>;

  putExperiment(scope: Scope, experiment: StoredBenchExperiment): Promise<StoredBenchExperiment>;
  getExperiment(scope: Scope, id: Id): Promise<StoredBenchExperiment | null>;
  /** Newest first. */
  listExperiments(scope: Scope): Promise<StoredBenchExperiment[]>;

  /** Replaces an experiment's whole plan — only while it is a draft. */
  replaceRuns(scope: Scope, experimentId: Id, runs: readonly StoredBenchRun[]): Promise<void>;
  putRun(scope: Scope, run: StoredBenchRun): Promise<void>;
  /** In queue order. */
  listRuns(scope: Scope, experimentId: Id): Promise<StoredBenchRun[]>;

  /** A label imported again replaces its earlier score. */
  putScore(scope: Scope, score: StoredBenchScore): Promise<void>;
  listScores(scope: Scope, experimentId: Id): Promise<StoredBenchScore[]>;
}
