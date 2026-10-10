import {
  parseAddressing,
  resolveAddressing,
  type AddressingError,
  type AddressingMode,
  type DeliveryMode,
  type Id,
  type NodeState,
  type RosterEntry,
} from '@ace/contracts';

/**
 * The composer's preview (D324–D326): who a message would reach, read by the same parser and the
 * same resolution the server applies, so the preview is what happens — and a message the server
 * would refuse is one the composer will not send.
 */
export interface MessagePreview {
  canSend: boolean;
  addressing?: AddressingMode;
  reaches: RosterEntry[];
  /** `@all` only: the nodes it skips because they have finished. */
  skips: RosterEntry[];
  errors: AddressingError[];
}

export interface PreviewInput {
  text: string;
  roster: readonly RosterEntry[];
  states: Readonly<Record<Id, NodeState>>;
  exclude: readonly Id[];
  deliveryMode: DeliveryMode;
}

export function previewMessage(input: PreviewInput): MessagePreview {
  if (input.text.trim() === '') return { canSend: false, reaches: [], skips: [], errors: [] };
  const entryOf = (nodeId: Id): RosterEntry[] =>
    input.roster.filter((entry) => entry.nodeId === nodeId);
  const resolved = resolveAddressing({
    parsed: parseAddressing(input.text, input.roster),
    roster: input.roster,
    states: input.states,
    deliveryMode: input.deliveryMode,
    exclude: input.exclude,
  });
  if (!resolved.ok) return { canSend: false, reaches: [], skips: [], errors: resolved.errors };
  return {
    canSend: true,
    addressing: resolved.addressing,
    reaches: resolved.recipients.flatMap(entryOf),
    skips: resolved.skipped.flatMap((skip) => entryOf(skip.nodeId)),
    errors: [],
  };
}
