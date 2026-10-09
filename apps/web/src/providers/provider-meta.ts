import type { CliPermission, CliProviderType, ProviderState, ProviderType } from '@ace/contracts';
import { PROVIDER_ACCENT, PROVIDER_STATUS } from '@ace/ui';

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

export const providerAccent = (type: ProviderType): string => PROVIDER_ACCENT[type];
export const providerStatusColor = (state: ProviderState): string => PROVIDER_STATUS[state];

/** D262's three presets, as the dialogs name them. */
export const CLI_PERMISSION_LABEL: Readonly<Record<CliPermission, string>> = {
  read_only: 'Read-only',
  edit_files: 'Edit project files',
  full_auto: 'Full auto',
};

export const CLI_PERMISSION_HINT: Readonly<Record<CliPermission, string>> = {
  read_only: 'Reads the project folder. Never writes a file or runs a command.',
  edit_files: 'Reads and edits files in the project folder. Runs no shell commands.',
  full_auto:
    'Runs any command on your machine without asking — on Windows with no sandbox. Use only for projects you trust.',
};

/**
 * Codex's presets are sandbox modes, not tool lists: it runs shell commands under both of the safer
 * two, inside its own sandbox (review I8). On native Windows that sandbox needs a one-time setup.
 */
const CODEX_PERMISSION_HINT: Readonly<Partial<Record<CliPermission, string>>> = {
  read_only: 'Reads the project folder and runs commands inside Codex’s read-only sandbox. Never edits a file.',
  edit_files:
    'Edits files in the project folder and runs commands inside Codex’s workspace sandbox. On Windows, set the sandbox up once: run codex, then /setup-default-sandbox.',
};

/** What a preset lets this CLI do, as the permission field spells it out. */
export function cliPermissionHint(type: CliProviderType, level: CliPermission): string {
  return (type === 'codex_cli' ? CODEX_PERMISSION_HINT[level] : undefined) ?? CLI_PERMISSION_HINT[level];
}
