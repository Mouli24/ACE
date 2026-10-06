import { z } from 'zod';

import {
  EdgeSchema,
  EntityNameSchema,
  IdSchema,
  NodeSchema,
  ProjectSchema,
  WorkflowSchema,
} from './graph.js';

/**
 * Workflow templates (round 5 §2.7, FR-ONB-002, Arch §33.1).
 *
 * The four starting points the onboarding wizard offers. Each is a graph defined in the engine's
 * code, wired to the mock provider by default, so every one of them runs to COMPLETE with no key
 * and no network (FR-ONB-002, TC-ONB-002).
 */

/** In the order the wizard lists them (FR-ONB-002). */
export const TEMPLATE_IDS = [
  'linear-chain',
  'review-fix',
  'parallel-research',
  'rag-qa',
  /* ACE parity P1 (D279): teams a task can be assigned to. */
  'single-builder',
  'plan-build-review',
] as const;
export const TemplateIdSchema = z.enum(TEMPLATE_IDS);
export type TemplateId = z.infer<typeof TemplateIdSchema>;

/** `GET /templates` → a bare `Template[]` (§2.7). */
export const TemplateSchema = z.strictObject({
  id: TemplateIdSchema,
  name: z.string().min(1),
  /** One line, for the wizard's card. */
  description: z.string().min(1),
  /** `rag-qa` needs a knowledge base, which instantiating it creates. */
  requires: z.strictObject({ knowledgeBase: z.boolean() }),
});
export type Template = z.infer<typeof TemplateSchema>;

/**
 * `POST /templates/:id/instantiate`. `projectId` puts the workflow in an existing project;
 * `projectName` names a new one. Naming both is refused. Naming neither makes a new project named
 * after the template — the wizard asks the user before it sends that (FR-ONB-001).
 */
export const InstantiateTemplateRequestSchema = z
  .strictObject({
    projectName: EntityNameSchema.optional(),
    projectId: IdSchema.optional(),
  })
  .refine((body) => body.projectName === undefined || body.projectId === undefined, {
    message: 'name a new project or an existing one, not both',
    path: ['projectId'],
  });
export type InstantiateTemplateRequest = z.infer<typeof InstantiateTemplateRequestSchema>;

/**
 * What `POST /templates/:id/instantiate` answers. `knowledgeBaseId` is set when the template
 * required one: for `rag-qa`, a new base on the mock embedder with one seeded sample document
 * (§2.7).
 */
export const InstantiateTemplateResponseSchema = z.strictObject({
  project: ProjectSchema,
  workflow: WorkflowSchema,
  nodes: z.array(NodeSchema),
  edges: z.array(EdgeSchema),
  knowledgeBaseId: IdSchema.optional(),
});
export type InstantiateTemplateResponse = z.infer<typeof InstantiateTemplateResponseSchema>;
