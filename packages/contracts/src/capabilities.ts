import { z } from 'zod';

import { IdSchema, TimestampSchema } from './graph.js';
import { CreateMcpServerRequestSchema } from './tools.js';

/**
 * Skills, bundles and secrets — the ACE parity P1 capability contract (docs/ACE_FEATURE_PARITY.md
 * §3.5–§3.6, D272–D274).
 *
 * A **skill** is reusable instructions for a kind of work. Installing one puts it in the library;
 * an agent uses it only once its `skillIds` names it (installation ≠ enablement). A run freezes the
 * text of every skill its agents use into its snapshot, so a skill edited later never changes what
 * an earlier run was asked (BR-04, TC-PRM-001).
 *
 * A **bundle** is a JSON file that groups skills and plugin (MCP server) definitions. Importing it
 * installs the skills and registers the servers; it connects nothing and enables nothing for any
 * agent — those stay separate steps, as ACE's docs require.
 *
 * A **secret** is a named environment variable for agent runs, checks and previews. Its value lives
 * in the OS keychain and is never returned; an agent's prompt sees only its name.
 */

/* -------------------------------------------------------------------------- */
/* Skills                                                                      */
/* -------------------------------------------------------------------------- */

export const SKILL_NAME_MAX = 80;
export const SKILL_DESCRIPTION_MAX = 500;
export const SKILL_INSTRUCTIONS_MAX = 20_000;

/** `builtin` ships with ACE and is read-only; `user` was written here; `bundle` came in a bundle. */
export const SKILL_SOURCES = ['builtin', 'user', 'bundle'] as const;
export const SkillSourceSchema = z.enum(SKILL_SOURCES);
export type SkillSource = z.infer<typeof SkillSourceSchema>;

export const SkillNameSchema = z.string().trim().min(1).max(SKILL_NAME_MAX);

export const SkillSchema = z.strictObject({
  id: IdSchema,
  name: SkillNameSchema,
  description: z.string().max(SKILL_DESCRIPTION_MAX),
  instructions: z.string().min(1).max(SKILL_INSTRUCTIONS_MAX),
  /** Starts at 1; every edit of the name or instructions adds one. */
  version: z.number().int().min(1),
  source: SkillSourceSchema,
  /** The bundle a `bundle` skill came from. */
  bundleId: IdSchema.optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Skill = z.infer<typeof SkillSchema>;

/** `POST /skills` → 201 `Skill` (source `user`, version 1). */
export const CreateSkillRequestSchema = z.strictObject({
  name: SkillNameSchema,
  description: z.string().max(SKILL_DESCRIPTION_MAX).optional(),
  instructions: z.string().trim().min(1).max(SKILL_INSTRUCTIONS_MAX),
});
export type CreateSkillRequest = z.infer<typeof CreateSkillRequestSchema>;

/** `PATCH /skills/:id` → `Skill`. A built-in skill is read-only (409 `skill_read_only`). */
export const UpdateSkillRequestSchema = z.strictObject({
  name: SkillNameSchema.optional(),
  description: z.string().max(SKILL_DESCRIPTION_MAX).optional(),
  instructions: z.string().trim().min(1).max(SKILL_INSTRUCTIONS_MAX).optional(),
});
export type UpdateSkillRequest = z.infer<typeof UpdateSkillRequestSchema>;

export const SkillListResponseSchema = z.strictObject({ items: z.array(SkillSchema) });
export type SkillListResponse = z.infer<typeof SkillListResponseSchema>;

/** What a run snapshot freezes of one skill an agent used (BR-04). */
export const SnapshotSkillSchema = z.strictObject({
  id: IdSchema,
  name: SkillNameSchema,
  version: z.number().int().min(1),
  instructions: z.string().min(1).max(SKILL_INSTRUCTIONS_MAX),
});
export type SnapshotSkill = z.infer<typeof SnapshotSkillSchema>;

/* -------------------------------------------------------------------------- */
/* Bundles                                                                     */
/* -------------------------------------------------------------------------- */

export const BUNDLE_FORMAT = 'ace-bundle';
export const BUNDLE_FORMAT_VERSION = 1;

/** The file a bundle is shared as. */
export const BundleFileSchema = z.strictObject({
  format: z.literal(BUNDLE_FORMAT),
  formatVersion: z.literal(BUNDLE_FORMAT_VERSION),
  name: z.string().trim().min(1).max(SKILL_NAME_MAX),
  description: z.string().max(SKILL_DESCRIPTION_MAX).optional(),
  skills: z
    .array(
      z.strictObject({
        name: SkillNameSchema,
        description: z.string().max(SKILL_DESCRIPTION_MAX).optional(),
        instructions: z.string().trim().min(1).max(SKILL_INSTRUCTIONS_MAX),
      }),
    )
    .max(50),
  /** Plugins: MCP server definitions, registered but never connected or enabled by an import. */
  mcpServers: z.array(CreateMcpServerRequestSchema).max(20).optional(),
});
export type BundleFile = z.infer<typeof BundleFileSchema>;

export const BundleSchema = z.strictObject({
  id: IdSchema,
  name: z.string().min(1).max(SKILL_NAME_MAX),
  description: z.string().max(SKILL_DESCRIPTION_MAX),
  skillIds: z.array(IdSchema),
  /** The MCP server definitions the bundle named, as it named them (not connected by the import). */
  mcpServers: z.array(CreateMcpServerRequestSchema),
  createdAt: TimestampSchema,
});
export type Bundle = z.infer<typeof BundleSchema>;

export const BundleListResponseSchema = z.strictObject({ items: z.array(BundleSchema) });
export type BundleListResponse = z.infer<typeof BundleListResponseSchema>;

/* -------------------------------------------------------------------------- */
/* Secrets                                                                     */
/* -------------------------------------------------------------------------- */

/** An environment variable name: uppercase letters, digits and underscores, starting with a letter. */
export const SECRET_NAME_REGEX = /^[A-Z][A-Z0-9_]{0,63}$/;
export const SecretNameSchema = z
  .string()
  .regex(SECRET_NAME_REGEX, 'must look like an environment variable: UPPER_SNAKE_CASE');
export const SECRET_VALUE_MAX = 10_000;
export const SECRET_DESCRIPTION_MAX = 200;

/**
 * Names the engine itself or a shell relies on: a secret may not shadow them, or a check would run
 * with a broken PATH and a run could be pointed at another data folder.
 */
export const RESERVED_SECRET_NAMES = [
  'PATH',
  'PATHEXT',
  'HOME',
  'USERPROFILE',
  'SYSTEMROOT',
  'COMSPEC',
  'TEMP',
  'TMP',
  'SHELL',
  'ACE_DATA_DIR',
  'ACE_PORT',
] as const;

/** A secret as the API shows it: never its value. */
export const SecretSchema = z.strictObject({
  name: SecretNameSchema,
  description: z.string().max(SECRET_DESCRIPTION_MAX),
  /** The projects whose runs, checks and previews receive it; empty means every project. */
  projectIds: z.array(IdSchema),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Secret = z.infer<typeof SecretSchema>;

const notReserved = (name: string, ctx: z.RefinementCtx): void => {
  if ((RESERVED_SECRET_NAMES as readonly string[]).includes(name)) {
    ctx.addIssue({ code: 'custom', path: ['name'], message: `${name} is reserved.` });
  }
};

/** `POST /secrets` → 201 `Secret`. */
export const CreateSecretRequestSchema = z
  .strictObject({
    name: SecretNameSchema,
    value: z.string().min(1).max(SECRET_VALUE_MAX),
    description: z.string().max(SECRET_DESCRIPTION_MAX).optional(),
    projectIds: z.array(IdSchema).optional(),
  })
  .superRefine((body, ctx) => notReserved(body.name, ctx));
export type CreateSecretRequest = z.infer<typeof CreateSecretRequestSchema>;

/** `PATCH /secrets/:name` → `Secret`. A new `value` replaces the stored one. */
export const UpdateSecretRequestSchema = z.strictObject({
  value: z.string().min(1).max(SECRET_VALUE_MAX).optional(),
  description: z.string().max(SECRET_DESCRIPTION_MAX).optional(),
  projectIds: z.array(IdSchema).optional(),
});
export type UpdateSecretRequest = z.infer<typeof UpdateSecretRequestSchema>;

export const SecretListResponseSchema = z.strictObject({ items: z.array(SecretSchema) });
export type SecretListResponse = z.infer<typeof SecretListResponseSchema>;
