import { z } from 'zod';

import { DEFAULT_MAX_UPLOAD_MB } from './artifacts.js';
import { BudgetUsdSchema, IdSchema } from './graph.js';

/** Engine settings (round 1 §2.7, round 4 §2.1, FR-SYS-005/010). */

export const THEMES = ['dark', 'light', 'system'] as const;
export const ThemeSchema = z.enum(THEMES);
export type Theme = z.infer<typeof ThemeSchema>;

export const DEFAULT_CONCURRENCY = 20;
export const DEFAULT_THEME: Theme = 'dark';
export const DEFAULT_ONBOARDING_COMPLETED = false;

/* Round 4 §2.1. `DEFAULT_MAX_UPLOAD_MB` lives with the upload rules it bounds, in artifacts.ts. */

/**
 * Whether the code sandbox uses Docker (D13, FR-TOOL-004): `auto` uses it when it is available and
 * falls back to a limited child process, `off` never uses it.
 */
export const DOCKER_SANDBOX_MODES = ['auto', 'off'] as const;
export const DockerSandboxModeSchema = z.enum(DOCKER_SANDBOX_MODES);
export type DockerSandboxMode = z.infer<typeof DockerSandboxModeSchema>;

export const DEFAULT_DOCKER_SANDBOX: DockerSandboxMode = 'auto';
export const DEFAULT_MCP_ENABLED = true;

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
  maxUploadMb: z.number().int().min(1).default(DEFAULT_MAX_UPLOAD_MB),
  /** The self-hosted SearXNG `web_search` queries; absent means no search tool (D14, FR-TOOL-005). */
  searxngUrl: z.url().optional(),
  dockerSandbox: DockerSandboxModeSchema.default(DEFAULT_DOCKER_SANDBOX),
  /** Whether MCP servers may be connected at all (D16, FR-TOOL-007). */
  mcpEnabled: z.boolean().default(DEFAULT_MCP_ENABLED),
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
  maxUploadMb: z.number().int().min(1).optional(),
  searxngUrl: z.url().optional(),
  dockerSandbox: DockerSandboxModeSchema.optional(),
  mcpEnabled: z.boolean().optional(),
});
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;
