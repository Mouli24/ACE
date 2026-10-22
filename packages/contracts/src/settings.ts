import { z } from 'zod';

import { ARTIFACT_UPLOAD_FIELD, DEFAULT_MAX_UPLOAD_MB } from './artifacts.js';
import { BudgetUsdSchema, IdSchema } from './graph.js';

/** Engine settings (round 1 §2.7, round 4 §2.1, round 5 §2.7, FR-SYS-005/010/012). */

export const THEMES = ['dark', 'light', 'system'] as const;
export const ThemeSchema = z.enum(THEMES);
export type Theme = z.infer<typeof ThemeSchema>;

export const DEFAULT_CONCURRENCY = 20;
export const DEFAULT_THEME: Theme = 'dark';
export const DEFAULT_ONBOARDING_COMPLETED = false;

/* Round 4 §2.1. `DEFAULT_MAX_UPLOAD_MB` lives with the upload rules it bounds, in artifacts.ts. */

/**
 * The highest upload limit that can be set (2 GB) [audit S-9]: an upload is held in memory whole, so
 * the setting is no longer unbounded. A PATCH over it is refused; a value saved before the ceiling
 * existed reads as the ceiling, rather than breaking every read of the settings.
 */
export const MAX_UPLOAD_MB = 2048;

/**
 * Whether the code sandbox uses Docker (D13, FR-TOOL-004): `auto` uses it when it is available and
 * falls back to a limited child process, `off` never uses it.
 */
export const DOCKER_SANDBOX_MODES = ['auto', 'off'] as const;
export const DockerSandboxModeSchema = z.enum(DOCKER_SANDBOX_MODES);
export type DockerSandboxMode = z.infer<typeof DockerSandboxModeSchema>;

export const DEFAULT_DOCKER_SANDBOX: DockerSandboxMode = 'auto';
export const DEFAULT_MCP_ENABLED = true;

/**
 * Round 5 §2.7: telemetry is off and stays off in v1 — no telemetry code ships (NFR-PRIV-01). The
 * field exists so the settings screen can say so, and it accepts no other value: a settings file or
 * a PATCH that turns it on is a validation error, not a silent no-op.
 */
export const TelemetryEnabledSchema = z.literal(false);
export const DEFAULT_TELEMETRY_ENABLED = false;

/** The dev origins the web app is served from (§2.7); a fresh array per parse. */
export const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
] as const;

const defaultAllowedOrigins = (): string[] => [...DEFAULT_ALLOWED_ORIGINS];

export const SettingsSchema = z.object({
  dataDir: z.string(),
  defaultProviderId: IdSchema.optional(),
  concurrency: z.number().int().min(1).max(64).default(DEFAULT_CONCURRENCY),
  theme: ThemeSchema.default(DEFAULT_THEME),
  lastProjectId: IdSchema.optional(),
  onboardingCompleted: z.boolean().default(DEFAULT_ONBOARDING_COMPLETED),
  allowedOrigins: z.array(z.string()).default(defaultAllowedOrigins),
  /** What all runs together may spend in a day; absent or null is no cap (round 3 §2.3, D72). */
  dailyBudgetUsd: BudgetUsdSchema.nullable().optional(),
  /** The upload limit in MB (round 4 §2.1, FR-MM-001); over it, `POST /artifacts` is 413. */
  maxUploadMb: z
    .number()
    .int()
    .min(1)
    .transform((mb) => Math.min(mb, MAX_UPLOAD_MB))
    .default(DEFAULT_MAX_UPLOAD_MB),
  /** The self-hosted SearXNG `web_search` queries; absent means no search tool (D14, FR-TOOL-005). */
  searxngUrl: z.url().optional(),
  dockerSandbox: DockerSandboxModeSchema.default(DEFAULT_DOCKER_SANDBOX),
  /** Whether MCP servers may be connected at all (D16, FR-TOOL-007). */
  mcpEnabled: z.boolean().default(DEFAULT_MCP_ENABLED),
  telemetryEnabled: TelemetryEnabledSchema.default(DEFAULT_TELEMETRY_ENABLED),
});
export type Settings = z.infer<typeof SettingsSchema>;

/**
 * `PATCH /settings` takes `Partial<Settings>` (§2.8). Built from the unwrapped field schemas so a
 * patch keeps every bound but fills in no defaults for fields it leaves out.
 */
export const SettingsPatchSchema = z.object({
  dataDir: z.string().optional(),
  defaultProviderId: IdSchema.optional(),
  concurrency: z.number().int().min(1).max(64).optional(),
  theme: ThemeSchema.optional(),
  lastProjectId: IdSchema.optional(),
  onboardingCompleted: z.boolean().optional(),
  allowedOrigins: z.array(z.string()).optional(),
  /** `null` removes the daily budget (D72). */
  dailyBudgetUsd: BudgetUsdSchema.nullable().optional(),
  maxUploadMb: z.number().int().min(1).max(MAX_UPLOAD_MB).optional(),
  searxngUrl: z.url().optional(),
  dockerSandbox: DockerSandboxModeSchema.optional(),
  mcpEnabled: z.boolean().optional(),
  telemetryEnabled: TelemetryEnabledSchema.optional(),
});
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

/* -------------------------------------------------------------------------- */
/* Backup and restore (round 5 §2.7, FR-SYS-012, TC-SYS-014)                   */
/* -------------------------------------------------------------------------- */

/*
 * Here rather than in a module of its own: the barrel's module list is fixed (round 1 §3 item 3),
 * and a backup is the settings screen's System section, as FR-SYS-012 is a System requirement.
 */

/**
 * `POST /backup/export` answers a `.zip` stream: a SQLite copy, the artifacts folder and the
 * settings — and never a key, because keys live in the keychain and are not in any of the three.
 */
export const BACKUP_CONTENT_TYPE = 'application/zip';

/** The multipart field `POST /backup/import` reads the zip from — the one uploads use. */
export const BACKUP_UPLOAD_FIELD = ARTIFACT_UPLOAD_FIELD;

/**
 * `POST /backup/import` → what the restore brought back. The engine takes a backup of the current
 * data first, so an import can itself be undone.
 */
export const BackupImportResponseSchema = z.strictObject({
  restored: z.strictObject({
    projects: z.number().int().min(0),
    runs: z.number().int().min(0),
    artifacts: z.number().int().min(0),
  }),
});
export type BackupImportResponse = z.infer<typeof BackupImportResponseSchema>;
