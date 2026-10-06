import { z } from 'zod';

import { ProviderStateSchema, ProviderTypeSchema, type ProviderType } from './enums.js';
import { IdSchema, TimestampSchema } from './graph.js';

/**
 * Providers (round 2 §2.1, FR-PRV-001..010, Arch §14.1).
 *
 * The one rule that shapes this module: an API key is never part of a `Provider`. It arrives on a
 * create or update request, goes to the `SecretStore`, and the only trace it leaves in the API is
 * the derived `keySet` boolean (FR-PRV-002, BR-07).
 */

export const ProviderNameSchema = z.string().min(1).max(80);

/** A provider's base URL — `openai_compatible` and `ollama` need one; the cloud types do not. */
export const ProviderBaseUrlSchema = z.url();

/* -------------------------------------------------------------------------- */
/* CLI providers (X1, FR-PRV-008, D261–D265)                                   */
/* -------------------------------------------------------------------------- */

/**
 * The provider types that run a locally installed coding-agent CLI with that CLI's own login (D261,
 * D264). They take no API key and no base URL; what they may do is a permission preset (D262).
 */
export const CLI_PROVIDER_TYPES = ['claude_code', 'codex_cli', 'gemini_cli'] as const;
export const CliProviderTypeSchema = z.enum(CLI_PROVIDER_TYPES);
export type CliProviderType = z.infer<typeof CliProviderTypeSchema>;

export function isCliProviderType(type: ProviderType): type is CliProviderType {
  return (CLI_PROVIDER_TYPES as readonly string[]).includes(type);
}

/** How a provider reaches its model: a cloud API, a local service, a local CLI, or the mock. */
export const PROVIDER_ROUTES = ['api', 'local', 'cli', 'mock'] as const;
export type ProviderRoute = (typeof PROVIDER_ROUTES)[number];

const ROUTE_BY_TYPE: Readonly<Record<ProviderType, ProviderRoute>> = {
  anthropic: 'api',
  google: 'api',
  openai: 'api',
  openai_compatible: 'local',
  ollama: 'local',
  mock: 'mock',
  claude_code: 'cli',
  codex_cli: 'cli',
  gemini_cli: 'cli',
};

/** The execution route of a provider type (X1 spec §3.1). Nothing in the runtime branches on it. */
export function routeOf(type: ProviderType): ProviderRoute {
  return ROUTE_BY_TYPE[type];
}

/** What a CLI provider may do in the project folder, mapped to each CLI's own flags (D262). */
export const CLI_PERMISSIONS = ['read_only', 'edit_files', 'full_auto'] as const;
export const CliPermissionSchema = z.enum(CLI_PERMISSIONS);
export type CliPermission = z.infer<typeof CliPermissionSchema>;
export const DEFAULT_CLI_PERMISSION: CliPermission = 'edit_files';

/** Two agents editing one folder at once collide, so a CLI provider starts at one call in flight. */
export const DEFAULT_CLI_CONCURRENCY = 1;

/**
 * How many calls the engine may have in flight against one provider (FR-PRV-009). D51: the bound
 * is §2.1's 1..64 and the default is the engine-wide `DEFAULT_CONCURRENCY`, so a provider added
 * without a limit is throttled by the global semaphore alone rather than by a number no doc names.
 */
export const PROVIDER_CONCURRENCY_MIN = 1;
export const PROVIDER_CONCURRENCY_MAX = 64;
export const DEFAULT_PROVIDER_CONCURRENCY = 20;

export const ProviderConcurrencySchema = z
  .number()
  .int()
  .min(PROVIDER_CONCURRENCY_MIN)
  .max(PROVIDER_CONCURRENCY_MAX);

export const ProviderSchema = z.object({
  id: IdSchema,
  type: ProviderTypeSchema,
  name: ProviderNameSchema,
  baseUrl: ProviderBaseUrlSchema.optional(),
  /** Derived from the SecretStore at read time — never a key, only whether one exists. */
  keySet: z.boolean(),
  status: ProviderStateSchema,
  statusMessage: z.string().optional(),
  lastCheckedAt: TimestampSchema.optional(),
  concurrency: ProviderConcurrencySchema,
  /** CLI providers only (D262): what the CLI may do in the project folder. */
  cliPermission: CliPermissionSchema.optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Provider = z.infer<typeof ProviderSchema>;

/**
 * `POST /providers`. `apiKey` is stored in the keychain and never written to the DB (§2.1). A CLI
 * provider brings its own login, so it refuses a key and a base URL; only a CLI provider takes a
 * permission level (D262, D264).
 */
export const CreateProviderRequestSchema = z
  .object({
    type: ProviderTypeSchema,
    name: ProviderNameSchema,
    apiKey: z.string().min(1).optional(),
    baseUrl: ProviderBaseUrlSchema.optional(),
    concurrency: ProviderConcurrencySchema.default(DEFAULT_PROVIDER_CONCURRENCY),
    cliPermission: CliPermissionSchema.optional(),
  })
  .superRefine((value, ctx) => {
    const cli = isCliProviderType(value.type);
    if (cli && value.apiKey !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['apiKey'],
        message: 'A CLI provider uses the CLI’s own login and takes no API key.',
      });
    }
    if (cli && value.baseUrl !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['baseUrl'], message: 'A CLI provider has no base URL.' });
    }
    if (!cli && value.cliPermission !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['cliPermission'],
        message: 'Only a CLI provider takes a permission level.',
      });
    }
  });
export type CreateProviderRequest = z.infer<typeof CreateProviderRequestSchema>;

/** `PATCH /providers/:id`. An `apiKey` present in the patch rotates the stored key (§2.1). */
export const UpdateProviderRequestSchema = z.object({
  name: ProviderNameSchema.optional(),
  apiKey: z.string().min(1).optional(),
  baseUrl: ProviderBaseUrlSchema.optional(),
  concurrency: ProviderConcurrencySchema.optional(),
  cliPermission: CliPermissionSchema.optional(),
});
export type UpdateProviderRequest = z.infer<typeof UpdateProviderRequestSchema>;

/** `POST /providers/:id/check` (FR-PRV-003); also the payload behind `provider.status`. */
export const ProviderCheckResultSchema = z.object({
  status: ProviderStateSchema,
  message: z.string().optional(),
  latencyMs: z.number().min(0).optional(),
  checkedAt: TimestampSchema,
});
export type ProviderCheckResult = z.infer<typeof ProviderCheckResultSchema>;

/** The address the engine probes for a local Ollama (FR-PRV-007). */
export const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';

/** `GET /providers/detect` — absent key means nothing answered on the default address. */
export const ProviderDetectResponseSchema = z.object({
  ollama: z
    .object({
      baseUrl: ProviderBaseUrlSchema,
      detected: z.boolean(),
    })
    .optional(),
});
export type ProviderDetectResponse = z.infer<typeof ProviderDetectResponseSchema>;

/* -------------------------------------------------------------------------- */
/* The terminal scan (X1, FR-PRV-008)                                          */
/* -------------------------------------------------------------------------- */

/** Whether a CLI is signed in, as far as ACE can tell without reading its credentials (D264). */
export const CLI_LOGIN_STATES = ['logged_in', 'logged_out', 'unknown'] as const;
export const CliLoginStateSchema = z.enum(CLI_LOGIN_STATES);
export type CliLoginState = z.infer<typeof CliLoginStateSchema>;

/** What to run to install each CLI — the install hint FR-PRV-008 asks for. */
export const CLI_INSTALL_HINTS: Readonly<Record<CliProviderType, string>> = {
  claude_code: 'npm install -g @anthropic-ai/claude-code',
  codex_cli: 'npm install -g @openai/codex',
  gemini_cli: 'npm install -g @google/gemini-cli',
};

/** What to run in a terminal to sign each CLI in. Gemini signs in on its first interactive run. */
export const CLI_LOGIN_HINTS: Readonly<Record<CliProviderType, string>> = {
  claude_code: 'claude auth login',
  codex_cli: 'codex login',
  gemini_cli: 'gemini',
};

/** One CLI as the terminal scan found it. Strict: nothing credential-shaped can ride along. */
export const CliDetectionSchema = z.strictObject({
  type: CliProviderTypeSchema,
  installed: z.boolean(),
  version: z.string().optional(),
  /** The file found on PATH, for display. */
  path: z.string().optional(),
  login: CliLoginStateSchema,
  /** How it is signed in, e.g. `claude.ai · max`, `ChatGPT`, `Google sign-in` — never an identity. */
  loginDetail: z.string().optional(),
  installHint: z.string(),
  loginHint: z.string(),
});
export type CliDetection = z.infer<typeof CliDetectionSchema>;

/** `GET /providers/detect/clis` — one entry per CLI type, in `CLI_PROVIDER_TYPES` order. */
export const CliDetectResponseSchema = z.strictObject({ items: z.array(CliDetectionSchema) });
export type CliDetectResponse = z.infer<typeof CliDetectResponseSchema>;

/**
 * Why a patch does not fit the provider it targets, or `undefined` when it does (X1, D262/D264).
 * A patch carries no type, so the engine checks it against the stored provider before applying it.
 */
export function cliPatchError(
  type: ProviderType,
  patch: UpdateProviderRequest,
): string | undefined {
  const cli = isCliProviderType(type);
  if (cli && patch.apiKey !== undefined) {
    return 'A CLI provider uses the CLI’s own login and takes no API key.';
  }
  if (cli && patch.baseUrl !== undefined) return 'A CLI provider has no base URL.';
  if (!cli && patch.cliPermission !== undefined) {
    return 'Only a CLI provider takes a permission level.';
  }
  return undefined;
}
