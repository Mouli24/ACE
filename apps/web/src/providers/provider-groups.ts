import {
  PROVIDER_GROUP_LABELS,
  providerGroup,
  type Model,
  type Provider,
  type ProviderGroup,
} from '@ace/contracts';
import { formatBytes } from '@ace/ui';

/**
 * PG-1.4: every provider picker groups its providers the same way — the contract's
 * `providerGroup`, so the engine and the web never disagree about what "local" means.
 */

/** The order the sections appear in. The test provider comes last. */
export const GROUP_ORDER: readonly ProviderGroup[] = ['cloud', 'local', 'cli', 'custom', 'mock'];

export interface ProviderSection {
  group: ProviderGroup;
  label: string;
  providers: Provider[];
}

/**
 * The providers in their sections, in `GROUP_ORDER`, keeping the list's own order inside each.
 * Empty sections are left out, except those named in `keep` (the Providers page keeps Local &
 * open models, so its "Pull a model" hint has a home).
 */
export function groupProviders(
  providers: readonly Provider[],
  keep: readonly ProviderGroup[] = [],
): ProviderSection[] {
  return GROUP_ORDER.flatMap((group) => {
    const members = providers.filter((provider) => providerGroup(provider) === group);
    return members.length > 0 || keep.includes(group)
      ? [{ group, label: PROVIDER_GROUP_LABELS[group], providers: members }]
      : [];
  });
}

/** The small model the "Pull a model" hint suggests: a few GB, tool calling, runs on a laptop. */
export const SUGGESTED_LOCAL_MODEL = 'llama3.2';
export const pullCommand = (model: string = SUGGESTED_LOCAL_MODEL) => `ollama pull ${model}`;

/** "1.2 GB · tools · JSON" — what the Local & open section says about a model on the machine. */
export function localModelFacts(
  model: Pick<Model, 'sizeBytes' | 'supportsTools' | 'supportsJson'>,
) {
  const parts: string[] = [];
  if (model.sizeBytes !== undefined) parts.push(formatBytes(model.sizeBytes));
  parts.push(model.supportsTools ? 'tools' : 'no tools');
  parts.push(model.supportsJson ? 'JSON' : 'no JSON');
  return parts.join(' · ');
}
