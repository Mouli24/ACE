import { z } from 'zod';

import {
  BudgetUsdSchema,
  EdgeSchema,
  EntityNameSchema,
  NodeSchema,
  WorkflowSchema,
} from './graph.js';
import { ValidationIssueSchema } from './validation.js';

/* -------------------------------------------------------------------------- */
/* Addresses (round 1 §2.1, §2.8, §2.10)                                       */
/* -------------------------------------------------------------------------- */

export const API_BASE_PATH = '/api/v1';
export const DEFAULT_ENGINE_PORT = 4747;
export const DEFAULT_ENGINE_ORIGIN = 'http://127.0.0.1:4747';
export const DEFAULT_WEB_ORIGIN = 'http://localhost:5173';

/** Where the web app keeps the session token it read from `?token=` (§2.10). */
export const SESSION_TOKEN_STORAGE_KEY = 'ace.token';

/* -------------------------------------------------------------------------- */
/* GET /health (FR-SYS-004)                                                    */
/* -------------------------------------------------------------------------- */

export const HealthResponseSchema = z.object({
  status: z.literal('ok'),
  version: z.string(),
  db: z.literal('ok'),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

/* -------------------------------------------------------------------------- */
/* Cursor pagination (§2.8: `?cursor=&limit=` -> `{ items, nextCursor? }`)      */
/* -------------------------------------------------------------------------- */

export const DEFAULT_PAGE_LIMIT = 50;

/** `limit` arrives in a query string, so a numeric string is coerced before it is bounded. */
export const CursorQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().default(DEFAULT_PAGE_LIMIT),
});
export type CursorQuery = z.infer<typeof CursorQuerySchema>;

export interface Page<T> {
  items: T[];
  nextCursor?: string;
}

/** Wrap any item schema as the §2.8 list envelope. */
export function pageSchema<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().optional(),
  });
}

/* -------------------------------------------------------------------------- */
/* Projects (FR-PRJ-001..004)                                                  */
/* -------------------------------------------------------------------------- */

export const CreateProjectRequestSchema = z.object({
  name: EntityNameSchema,
  folderPath: z.string().optional(),
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequestSchema>;

export const UpdateProjectRequestSchema = z.object({
  name: EntityNameSchema.optional(),
  /** Round 3 §2.3: the run cost cap; `null` removes it (D72). */
  maxCostPerRunUsd: BudgetUsdSchema.nullable().optional(),
});
export type UpdateProjectRequest = z.infer<typeof UpdateProjectRequestSchema>;

/* -------------------------------------------------------------------------- */
/* Workflows (FR-WF-001..008)                                                  */
/* -------------------------------------------------------------------------- */

export const CreateWorkflowRequestSchema = z.object({ name: EntityNameSchema });
export type CreateWorkflowRequest = z.infer<typeof CreateWorkflowRequestSchema>;

export const UpdateWorkflowRequestSchema = z.object({ name: EntityNameSchema.optional() });
export type UpdateWorkflowRequest = z.infer<typeof UpdateWorkflowRequestSchema>;

/** `GET /workflows/:id`, `POST /workflows/:id/duplicate` and workflow import all answer with this. */
export const WorkflowGraphResponseSchema = z.object({
  workflow: WorkflowSchema,
  nodes: z.array(NodeSchema),
  edges: z.array(EdgeSchema),
});
export type WorkflowGraphResponse = z.infer<typeof WorkflowGraphResponseSchema>;

export const ValidateWorkflowResponseSchema = z.object({
  issues: z.array(ValidationIssueSchema),
});
export type ValidateWorkflowResponse = z.infer<typeof ValidateWorkflowResponseSchema>;
