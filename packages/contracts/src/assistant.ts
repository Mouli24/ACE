import { z } from 'zod';

import {
  BudgetUsdSchema,
  EntityNameSchema,
  IdSchema,
  ProjectSchema,
  WorkflowSchema,
} from './graph.js';

/**
 * Ace Assistant project setup — the ACE parity P2 contract (docs/ACE_FEATURE_PARITY.md §3.1, D283).
 *
 * The user describes the work; the Assistant proposes a project, a team (one of the coding team
 * templates, with each agent's name, role, instructions and model) and a run budget. The user reads
 * it, asks for changes (a new proposal from the old one and the request), and confirms; only the
 * confirmation creates anything. A proposal is drafted by a connected model when one is chosen, and
 * by plain rules otherwise — it says which.
 */

export const ASSISTANT_TEAMS = ['single-builder', 'plan-build-review'] as const;
export const AssistantTeamSchema = z.enum(ASSISTANT_TEAMS);
export type AssistantTeam = z.infer<typeof AssistantTeamSchema>;

export const ASSISTANT_ROLES = ['planner', 'builder', 'reviewer'] as const;
export const AssistantRoleSchema = z.enum(ASSISTANT_ROLES);
export type AssistantRole = z.infer<typeof AssistantRoleSchema>;

export const AssistantAgentSchema = z.strictObject({
  role: AssistantRoleSchema,
  name: z.string().trim().min(1).max(80),
  instructions: z.string().trim().min(1).max(8_000),
  /** The model this agent runs on; absent keeps the template's (the no-key mock). */
  providerId: IdSchema.optional(),
  modelId: z.string().min(1).optional(),
});
export type AssistantAgent = z.infer<typeof AssistantAgentSchema>;

export const ASSISTANT_SOURCES = ['model', 'rules'] as const;
export const AssistantSourceSchema = z.enum(ASSISTANT_SOURCES);
export type AssistantSource = z.infer<typeof AssistantSourceSchema>;

export const AssistantProposalSchema = z.strictObject({
  /** One paragraph: what will be set up and why. */
  summary: z.string().min(1).max(2_000),
  /** A new project's name; ignored when `projectId` names an existing one. */
  projectName: EntityNameSchema,
  projectId: IdSchema.optional(),
  team: AssistantTeamSchema,
  agents: z.array(AssistantAgentSchema).min(1).max(3),
  /** The run cost cap the project gets; absent leaves none. */
  maxCostPerRunUsd: BudgetUsdSchema.optional(),
  /** What the Assistant assumed or could not do, in plain sentences. */
  notes: z.array(z.string().max(500)).max(10),
  source: AssistantSourceSchema,
});
export type AssistantProposal = z.infer<typeof AssistantProposalSchema>;

/**
 * `POST /assistant/propose` → `AssistantProposal`. `previous` and `prompt` together are "tell Ace
 * what to change": the new proposal revises the old one.
 */
export const AssistantProposeRequestSchema = z.strictObject({
  prompt: z.string().trim().min(1).max(4_000),
  projectId: IdSchema.optional(),
  /** The model that drafts the proposal; without one, rules do. */
  providerId: IdSchema.optional(),
  modelId: z.string().min(1).optional(),
  previous: AssistantProposalSchema.optional(),
});
export type AssistantProposeRequest = z.infer<typeof AssistantProposeRequestSchema>;

/** `POST /assistant/apply` — the confirmation tick. */
export const AssistantApplyRequestSchema = z.strictObject({
  proposal: AssistantProposalSchema,
  /** A new project's folder; the engine's default when absent. */
  folderPath: z.string().min(1).optional(),
});
export type AssistantApplyRequest = z.infer<typeof AssistantApplyRequestSchema>;

export const AssistantApplyResponseSchema = z.strictObject({
  project: ProjectSchema,
  workflow: WorkflowSchema,
});
export type AssistantApplyResponse = z.infer<typeof AssistantApplyResponseSchema>;
