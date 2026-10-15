import { z } from 'zod';

import { PartSchema } from './envelope.js';
import { EventSchema } from './events.js';
import { EdgeSchema, FormatVersionSchema, IdSchema, NodeSchema, TimestampSchema } from './graph.js';
import { NodeRunSchema, RunSchema } from './runs.js';

/**
 * The workflow export/import file (round 1 §2.7, FR-WF-007/008).
 *
 * Provider ids are kept so an imported workflow still points at the right provider, but never a
 * key: no field of this schema holds one, and because every object here strips unknown keys, a
 * key smuggled into a file is dropped on parse rather than carried through (TC-WF-007).
 */
export const WorkflowExportSchema = z.object({
  formatVersion: FormatVersionSchema,
  exportedAt: TimestampSchema,
  name: z.string(),
  nodes: z.array(NodeSchema),
  edges: z.array(EdgeSchema),
});
export type WorkflowExport = z.infer<typeof WorkflowExportSchema>;

/* -------------------------------------------------------------------------- */
/* Run export (PG-5.5, FR-BEN-005)                                             */
/* -------------------------------------------------------------------------- */

/**
 * `GET /runs/:id/export?anonymise=1` — one run, bundled for judging: the run record (snapshot,
 * inputs, totals), every node run, the outputs by node and the run's event log. Separate from
 * `WorkflowExportSchema`, which is a graph to import and carries no runs.
 *
 * `anonymised: true` is the blind-judging form (FR-BEN-005, TC-BEN-004): node names become
 * "Node 1".."Node n" in snapshot order, every provider and model id or name is removed — from the
 * snapshot, the node runs and the event payloads — and every string that spelled one of them is
 * rewritten. Never a secret in either form: the engine masks key-shaped strings throughout.
 */
export const RunExportQuerySchema = z.object({
  anonymise: z
    .enum(['0', '1', 'true', 'false'])
    .optional()
    .transform((value) => value === '1' || value === 'true'),
});
export type RunExportQuery = z.infer<typeof RunExportQuerySchema>;

export const RunExportSchema = z.object({
  formatVersion: FormatVersionSchema,
  exportedAt: TimestampSchema,
  anonymised: z.boolean(),
  run: RunSchema,
  nodeRuns: z.array(NodeRunSchema),
  /** Each node's final output: its latest COMPLETED node run (last iteration, last attempt). */
  outputs: z.record(IdSchema, z.array(PartSchema)),
  /** The run's append-only event log, in `seq` order (BR-04). */
  events: z.array(EventSchema),
});
export type RunExport = z.infer<typeof RunExportSchema>;
