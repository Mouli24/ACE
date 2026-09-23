import type { ProviderState, ProviderType } from '@ace/contracts';
import { PROVIDER_ACCENT, PROVIDER_STATUS } from '@ace/ui';

export { PROVIDER_STATE_LABEL } from '@ace/ui';

/** Human labels for the six `ProviderType`s (§2.1). The enum value stays the wire value. */
export const PROVIDER_TYPE_LABEL: Readonly<Record<ProviderType, string>> = {
  anthropic: 'Anthropic',
  google: 'Google',
  openai: 'OpenAI',
  openai_compatible: 'OpenAI-compatible',
  ollama: 'Ollama',
  mock: 'Mock',
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
