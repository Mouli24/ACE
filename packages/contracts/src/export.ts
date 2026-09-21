import { z } from 'zod';

import { EdgeSchema, FormatVersionSchema, NodeSchema, TimestampSchema } from './graph.js';

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
