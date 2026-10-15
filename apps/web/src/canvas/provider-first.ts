import type { Node, Provider } from '@ace/contracts';

import type { CanvasNodeKind, NewNodeInit } from '../nodes/factory';
import type { ProviderChoice } from '../providers/provider-picker-store';

/**
 * PG-1.3 (D351): which Canvas paths must ask for a provider first. An Agent or Model node is never
 * created without one — Add node, a palette drop and a context-menu Add open the picker unless the
 * drag already named a provider; Duplicate asks only for copies that would be born without a usable
 * one. Paste and import keep the source's provider and, when it is absent, show the card's red
 * "Choose a provider" state instead.
 */

const STAGE_KINDS: ReadonlySet<string> = new Set(['agent', 'model']);

export const isStageKind = (kind: string): boolean => STAGE_KINDS.has(kind);

/** Whether placing a node of this kind with this init must wait for the picker. */
export function needsProviderChoice(kind: CanvasNodeKind, init?: NewNodeInit): boolean {
  return isStageKind(kind) && (init?.providerId === undefined || init.providerId === '');
}

/** Whether a node is an Agent/Model whose provider is not set or not one the engine has. */
export function lacksUsableProvider(node: Node, providers: readonly Provider[]): boolean {
  if (node.kind !== 'agent' && node.kind !== 'model') return false;
  const { providerId } = node.config;
  return (
    providerId === undefined ||
    providerId === '' ||
    !providers.some((provider) => provider.id === providerId)
  );
}

/** The node on the chosen provider and model; any other kind is returned as it is. */
export function withProviderChoice(node: Node, choice: ProviderChoice): Node {
  if (node.kind !== 'agent' && node.kind !== 'model') return node;
  return {
    ...node,
    config: { ...node.config, providerId: choice.providerId, modelId: choice.modelId },
  } as Node;
}
