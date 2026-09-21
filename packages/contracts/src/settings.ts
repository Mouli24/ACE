import { z } from 'zod';

import { IdSchema } from './graph.js';

/** Engine settings (round 1 §2.7, FR-SYS-005/010). */

export const THEMES = ['dark', 'light', 'system'] as const;
export const ThemeSchema = z.enum(THEMES);
export type Theme = z.infer<typeof ThemeSchema>;

export const DEFAULT_CONCURRENCY = 20;
export const DEFAULT_THEME: Theme = 'dark';
export const DEFAULT_ONBOARDING_COMPLETED = false;

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
});
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;
