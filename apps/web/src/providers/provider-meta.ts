import type { CliPermission, CliProviderType, ProviderType } from '@ace/contracts';

export { PROVIDER_STATE_LABEL } from '@ace/ui';

/** Human labels for every `ProviderType` (§2.1, X1). The enum value stays the wire value. */
export const PROVIDER_TYPE_LABEL: Readonly<Record<ProviderType, string>> = {
  anthropic: 'Anthropic',
  google: 'Google',
  openai: 'OpenAI',
  openai_compatible: 'OpenAI-compatible',
  ollama: 'Ollama',
  mock: 'Mock',
  claude_code: 'Claude Code',
  codex_cli: 'Codex CLI',
  gemini_cli: 'Gemini CLI',
};

/** Which types need an API key, and which need a base URL (§2.1, FR-PRV-001). */
export const NEEDS_API_KEY: ReadonlySet<ProviderType> = new Set<ProviderType>([
  'anthropic',
  'google',
  'openai',
]);
export const NEEDS_BASE_URL: ReadonlySet<ProviderType> = new Set<ProviderType>([
  'openai_compatible',
  'ollama',
]);

/**
 * D355 (PG-2.3): the presets a CLI provider is offered. D262's third, `full_auto`, bypassed every
 * ACE approval, budget and guardrail; it stays in the contract only so an old row parses, and such
 * a row runs — and is shown — as `edit_files`.
 */
export const OFFERED_CLI_PERMISSIONS = ['read_only', 'edit_files'] as const satisfies readonly CliPermission[];

/** The preset a stored permission is shown and edited as (D355: `full_auto` reads as `edit_files`). */
export const offeredCliPermission = (level: CliPermission): CliPermission =>
  level === 'full_auto' ? 'edit_files' : level;

/** The presets as the dialogs name them; an old `full_auto` row is named as what it runs as. */
export const CLI_PERMISSION_LABEL: Readonly<Record<CliPermission, string>> = {
  read_only: 'Read-only',
  edit_files: 'Edit project files',
  full_auto: 'Edit project files',
};

export const CLI_PERMISSION_HINT: Readonly<Record<CliPermission, string>> = {
  read_only: 'Reads the project folder. Never writes a file or runs a command.',
  edit_files: 'Reads and edits files in the project folder. Runs no shell commands.',
  full_auto: 'Reads and edits files in the project folder. Runs no shell commands.',
};

/**
 * Codex's presets are sandbox modes, not tool lists: it runs shell commands under both of the safer
 * two, inside its own sandbox (review I8). On native Windows that sandbox needs a one-time setup.
 */
const CODEX_PERMISSION_HINT: Readonly<Partial<Record<CliPermission, string>>> = {
  read_only:
    'Reads the project folder and runs commands inside Codex’s read-only sandbox. Never edits a file.',
  edit_files:
    'Edits files in the project folder and runs commands inside Codex’s workspace sandbox. On Windows, set the sandbox up once: run codex, then /setup-default-sandbox.',
};

/** What a preset lets this CLI do, as the permission field spells it out. */
export function cliPermissionHint(type: CliProviderType, level: CliPermission): string {
  const shown = offeredCliPermission(level);
  return (
    (type === 'codex_cli' ? CODEX_PERMISSION_HINT[shown] : undefined) ?? CLI_PERMISSION_HINT[shown]
  );
}
