import {
  isAddressableNode,
  type FailureReason,
  type HaltReason,
  type Id,
  type Node,
  type NodeState,
} from '@ace/contracts';

import { agentMap } from '../theme/agents';
import { agentColor } from '../theme/constants';
import { initial } from '../theme/format';

/*
 * How Domain dresses its participants in the Ace UI theme (D328, D336): each agent's colour and
 * letter — the same ones the canvas and Forge use, by graph order — its model, and the Team
 * aside's status pills.
 */

export interface DomainLook {
  color: string;
  letter: string;
  /** The node's configured model id; undefined when it has none. */
  model: string | undefined;
}

export type DomainLooks = ReadonlyMap<Id, DomainLook>;

/** Every agent and model node of a run's snapshot, by id. */
export function domainLooks(nodes: readonly Node[]): Map<Id, DomainLook> {
  const agents = agentMap(nodes);
  return new Map(
    nodes.filter(isAddressableNode).map((node, index): [Id, DomainLook] => {
      const agent = agents.get(node.id);
      return [
        node.id,
        {
          color: agent?.color ?? agentColor(index),
          letter: agent?.letter ?? initial(node.name),
          model: node.config.modelId,
        },
      ];
    }),
  );
}

/** A node's look, or — for one the snapshot does not know — its place's colour and its initial. */
export function lookOf(
  looks: DomainLooks | undefined,
  nodeId: Id,
  name: string,
  index: number,
): DomainLook {
  return (
    looks?.get(nodeId) ?? { color: agentColor(index), letter: initial(name), model: undefined }
  );
}

/** A status pill in the Team aside: its word, fill and ink, and whether its dot pulses. */
export interface StatusPill {
  label: string;
  bg: string;
  ink: string;
  pulse: boolean;
}

/**
 * PG-4.2 (D360): one pill per node state — nine words, nine colours, the canvas's own
 * (`--color-status-*`, AA in both themes) — so a node not yet started, one ready, one held on an
 * approval and one paused no longer all read "Waiting", and Failed never reads as Blocked.
 */
const pill = (state: NodeState, label: string, pulse = false): StatusPill => ({
  label,
  bg: `color-mix(in srgb, var(--color-status-${state}) 14%, transparent)`,
  ink: `var(--color-status-${state})`,
  pulse,
});

const PILLS: Record<NodeState, StatusPill> = {
  IDLE: pill('IDLE', 'Idle'),
  READY: pill('READY', 'Ready'),
  RUNNING: pill('RUNNING', 'Working', true),
  WAITING: pill('WAITING', 'Needs approval', true),
  PAUSED: pill('PAUSED', 'Paused'),
  COMPLETED: pill('COMPLETED', 'Done'),
  STOPPED: pill('STOPPED', 'Stopped'),
  BLOCKED: pill('BLOCKED', 'Blocked'),
  FAILED: pill('FAILED', 'Failed'),
};

export function statusPill(state: NodeState): StatusPill {
  return PILLS[state];
}

/**
 * Each failure reason in words (PG-4.2, BR-03): the four stay distinct — a broken contract, a
 * failed call, a guardrail and a block upstream are different stories. The enum stays the contract's.
 */
const FAILURE_WORDS: Readonly<Record<FailureReason, string>> = {
  CONTRACT_VIOLATION: 'Its output did not match the contract',
  RUN_FAILED: 'The call failed',
  GUARDRAIL_VIOLATION: 'Stopped by a guardrail',
  BLOCKED: 'Never ran — blocked upstream',
};

export function failureWords(reason: FailureReason): string {
  return FAILURE_WORDS[reason];
}

/** Why a run halted, in words, for the run pill (PG-4.2). */
const HALT_WORDS: Readonly<Record<HaltReason, string>> = {
  stopped: 'stopped',
  budget_exceeded: 'budget reached',
  failure: 'a node failed',
  shutdown: 'engine shut down',
  crash: 'engine crashed',
};

export function haltWords(reason: HaltReason): string {
  return HALT_WORDS[reason];
}

/** A duration as the theme writes it: whole seconds, `4s`. */
export function seconds(ms: number): string {
  return `${Math.round(ms / 1000)}s`;
}

/** `1 step`, `3 steps`. */
export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
