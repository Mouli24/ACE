import { z } from 'zod';

import {
  FailureReasonSchema,
  NodeStateSchema,
  ProviderTypeSchema,
  type NodeState,
} from './enums.js';
import { PartSchema } from './envelope.js';
import { IdSchema, TimestampSchema, type Id, type Node } from './graph.js';
import type { ValidationIssue } from './validation.js';

/**
 * Domain — the team-chat view of a run (D303–D327).
 *
 * Domain is a projection of the run event log: the engine folds a run's events into chat messages
 * and usage snapshots and the web only renders them. This module is the seam for it: the roster and
 * the one addressing parser the engine and the composer share (D308, D324, D326), the payloads of
 * the run events Domain adds (D303), the projected shapes, the HTTP/SSE bodies (D314) and the
 * `ace.pricing.json` schema (D306).
 *
 * Names start with `Domain` where they would otherwise collide: `ChatMessage` and the
 * `chat.message` frame already belong to direct chat (D285).
 */

/* -------------------------------------------------------------------------- */
/* Handles and the roster (D308)                                               */
/* -------------------------------------------------------------------------- */

export const HANDLE_MAX = 32;
export const HANDLE_REGEX = /^[a-z][a-z0-9-]{0,31}$/;
export const HandleSchema = z
  .string()
  .regex(
    HANDLE_REGEX,
    'a handle is a lowercase letter, then letters, digits or hyphens (32 at most)',
  );
export type Handle = z.infer<typeof HandleSchema>;

/** Handles no node may take: `@brain` is the Brain's (D304), `@all` addresses everyone (D326). */
export const RESERVED_HANDLES = ['brain', 'all'] as const;

/** Names never matched as plain words (D324): a node called "All" is still `@all-2`. */
export const RESERVED_NAME_WORDS = ['all', 'everyone', 'brain'] as const;

/** Only nodes that take turns can be addressed. */
export const ADDRESSABLE_NODE_KINDS = ['agent', 'model'] as const;
export type AddressableNodeKind = (typeof ADDRESSABLE_NODE_KINDS)[number];

export const RosterEntrySchema = z.strictObject({
  nodeId: IdSchema,
  handle: HandleSchema,
  name: z.string().min(1),
  kind: z.enum(ADDRESSABLE_NODE_KINDS),
  brain: z.boolean(),
});
export type RosterEntry = z.infer<typeof RosterEntrySchema>;

export const isAddressableNode = (
  node: Node,
): node is Extract<Node, { kind: AddressableNodeKind }> =>
  node.kind === 'agent' || node.kind === 'model';

/** The workflow's Brain (D304): the one Agent whose config says so. */
export const isBrainNode = (node: Node): boolean =>
  node.kind === 'agent' && node.config.brain === true;

const isReservedHandle = (handle: string): boolean =>
  (RESERVED_HANDLES as readonly string[]).includes(handle);

/** A node's name as a default handle: lowercase, words joined by hyphens, starting with a letter. */
export function slugHandle(name: string): string {
  let slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug === '') slug = 'node';
  if (!/^[a-z]/.test(slug)) slug = `n-${slug}`;
  return slug.slice(0, HANDLE_MAX).replace(/-+$/, '');
}

/** `base`, `base-2`, `base-3`, … — the first one free, cut so it still fits in 32 characters. */
function numbered(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base) && !isReservedHandle(base)) return base;
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, HANDLE_MAX - suffix.length).replace(/-+$/, '')}${suffix}`;
    if (!taken.has(candidate) && !isReservedHandle(candidate)) return candidate;
  }
}

/**
 * The run's roster (D308): every agent and model node with its handle, in creation (ULID) order.
 * The Brain is always `@brain`; an explicit `handle` is kept; every other node gets a slug of its
 * name, numbered when it collides with one already taken. Pure, so the engine freezes it from the
 * run's snapshot and the composer computes the same one from the graph.
 */
export function rosterFor(nodes: readonly Node[]): RosterEntry[] {
  const addressable = nodes
    .filter(isAddressableNode)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const taken = new Set<string>();
  const handles = new Map<Id, string>();
  for (const node of addressable) {
    if (isBrainNode(node)) {
      handles.set(node.id, 'brain');
    } else if (
      node.handle !== undefined &&
      HANDLE_REGEX.test(node.handle) &&
      !isReservedHandle(node.handle) &&
      !taken.has(node.handle)
    ) {
      handles.set(node.id, node.handle);
      taken.add(node.handle);
    }
  }
  for (const node of addressable) {
    if (handles.has(node.id)) continue;
    const handle = numbered(slugHandle(node.name), taken);
    handles.set(node.id, handle);
    taken.add(handle);
  }

  return addressable.map((node) => ({
    nodeId: node.id,
    handle: handles.get(node.id) ?? slugHandle(node.name),
    name: node.name,
    kind: node.kind,
    brain: isBrainNode(node),
  }));
}

/** The graph-op refusals Domain adds (D304, D308): each a 400 `validation_failed` issue. */
export const DOMAIN_GRAPH_ISSUE_CODES = [
  'duplicate_handle',
  'reserved_handle',
  'more_than_one_brain',
] as const;

/**
 * What a workflow's handles and Brain must satisfy (D304, D308): an explicit handle is unique and
 * not reserved, and at most one Agent is the Brain. Pure, so the engine refuses the graph op and the
 * Canvas can say why before it sends one.
 */
export function domainGraphIssues(nodes: readonly Node[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const seen = new Map<string, Id>();
  for (const node of nodes) {
    if (node.handle === undefined) continue;
    if (isReservedHandle(node.handle)) {
      issues.push({
        severity: 'error',
        code: 'reserved_handle',
        message: `@${node.handle} is reserved — ${node.handle === 'brain' ? 'it is the Brain' : 'it addresses every node'}; choose another handle for "${node.name}".`,
        nodeId: node.id,
      });
      continue;
    }
    const other = seen.get(node.handle);
    if (other !== undefined) {
      issues.push({
        severity: 'error',
        code: 'duplicate_handle',
        message: `@${node.handle} is already another node's handle; each handle names one node.`,
        nodeId: node.id,
      });
      continue;
    }
    seen.set(node.handle, node.id);
  }
  const brains = nodes.filter((node) => node.kind === 'agent' && node.config.brain === true);
  for (const extra of brains.slice(1)) {
    issues.push({
      severity: 'error',
      code: 'more_than_one_brain',
      message: `Only one node can be the Brain; "${brains[0]?.name ?? ''}" already is.`,
      nodeId: extra.id,
    });
  }
  return issues;
}

/* -------------------------------------------------------------------------- */
/* Addressing (D324, D326)                                                     */
/* -------------------------------------------------------------------------- */

export const DELIVERY_MODES = ['queue', 'interrupt'] as const;
export const DeliveryModeSchema = z.enum(DELIVERY_MODES);
export type DeliveryMode = z.infer<typeof DeliveryModeSchema>;

export const ADDRESS_VIAS = ['name', 'handle', 'all'] as const;
export type AddressVia = (typeof ADDRESS_VIAS)[number];

/** One stretch of the text that addressed something. `nodeId` is absent for `@all`. */
export interface AddressSpan {
  start: number;
  end: number;
  via: AddressVia;
  nodeId?: Id;
  text: string;
}

export const ADDRESSING_ERROR_CODES = [
  'unknown_handle',
  'ambiguous_name',
  'no_brain',
  'all_with_others',
  'all_finished',
  'all_queue_only',
  'exclude_not_matched',
] as const;
export const AddressingErrorCodeSchema = z.enum(ADDRESSING_ERROR_CODES);
export type AddressingErrorCode = z.infer<typeof AddressingErrorCodeSchema>;

/** What the composer shows and what a 400 carries in `details.errors` (nothing half-sends). */
export const AddressingErrorSchema = z.strictObject({
  code: AddressingErrorCodeSchema,
  message: z.string(),
  span: z.strictObject({ start: z.number().int(), end: z.number().int() }).optional(),
  /** `unknown_handle`: the handle as typed, with its `@`. */
  handle: z.string().optional(),
  /** `unknown_handle`: the closest roster handles, with their `@`. */
  suggestions: z.array(z.string()).optional(),
  /** `ambiguous_name`: every node sharing the name, by `@handle`. */
  handles: z.array(z.string()).optional(),
  /** `exclude_not_matched`: the node the exclude list named. */
  nodeId: IdSchema.optional(),
});
export type AddressingError = z.infer<typeof AddressingErrorSchema>;

export interface ParsedAddressing {
  /** `@all` was used. */
  all: boolean;
  /** Nodes addressed by name or `@handle`, in the order they first appear. Empty for `@all`. */
  recipients: Id[];
  spans: AddressSpan[];
  errors: AddressingError[];
}

/** Letters, digits and `_` are word characters; `@` belongs to a handle, never to a name's edge. */
const WORD = /[\p{L}\p{N}_@]/u;
const isWordChar = (ch: string | undefined): boolean => ch !== undefined && WORD.test(ch);

/** A name's edges: not inside a word, a handle, an email address or a dotted domain. */
function atNameBoundary(text: string, start: number, end: number): boolean {
  const before = text[start - 1];
  const after = text[end];
  if (isWordChar(before) || isWordChar(after)) return false;
  if (before === '.' && isWordChar(text[start - 2])) return false;
  if (after === '.' && isWordChar(text[end + 1])) return false;
  return true;
}

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const normalizeName = (name: string): string => name.trim().replace(/\s+/g, ' ').toLowerCase();

/** Levenshtein distance — small strings only, so the quadratic table is fine. */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = row[0] ?? 0;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = row[j] ?? 0;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(above + 1, (row[j - 1] ?? 0) + 1, diagonal + cost);
      diagonal = above;
    }
  }
  return row[b.length] ?? 0;
}

/** The roster handles nearest to one that matched nothing — at most three, nearest first. */
export function closestHandles(handle: string, roster: readonly RosterEntry[]): string[] {
  const wanted = handle.replace(/^@/, '').toLowerCase();
  const candidates = [...roster.map((entry) => entry.handle), 'all'];
  const limit = Math.max(2, Math.floor(wanted.length / 3));
  return candidates
    .map((candidate) => ({
      candidate,
      score: candidate.startsWith(wanted) ? 0 : distance(wanted, candidate),
    }))
    .filter(({ score }) => score <= limit)
    .sort((a, b) => a.score - b.score || a.candidate.localeCompare(b.candidate))
    .slice(0, 3)
    .map(({ candidate }) => `@${candidate}`);
}

const HANDLE_TOKEN = /@([A-Za-z0-9][A-Za-z0-9-]*)/gu;

/**
 * Read who a human message addresses (D324, D326). Agent output never goes through this: agents
 * address each other only through envelope blocks (D310).
 *
 * - `@handle`: any roster handle, `@brain` for the Brain, `@all` for everyone not finished.
 * - A plain name: whole words, case-insensitive, the full name (a multi-word name only as the whole
 *   phrase), longest match first, so "Risk Analyst" beats "Risk". A name two nodes share is an
 *   error that lists their handles; a node named "all", "everyone" or "brain" is never matched by
 *   its name.
 * - `@all` with anything else, an unknown handle, an ambiguous name: errors. The caller sends
 *   nothing when there is one (nothing half-sends).
 */
export function parseAddressing(text: string, roster: readonly RosterEntry[]): ParsedAddressing {
  const spans: AddressSpan[] = [];
  const errors: AddressingError[] = [];
  const byHandle = new Map(roster.map((entry) => [entry.handle, entry]));
  const brain = roster.find((entry) => entry.brain);
  let all = false;

  /* 1. Handles. An `@` inside a word (an email address) is not one. */
  const handleSpans: { start: number; end: number }[] = [];
  for (const match of text.matchAll(HANDLE_TOKEN)) {
    const start = match.index;
    if (isWordChar(text[start - 1]) || text[start - 1] === '.' || text[start - 1] === '-') continue;
    const raw = (match[1] ?? '').replace(/-+$/, '');
    const end = start + 1 + raw.length;
    const handle = raw.toLowerCase();
    const typed = text.slice(start, end);
    handleSpans.push({ start, end });

    if (handle === 'all') {
      all = true;
      spans.push({ start, end, via: 'all', text: typed });
      continue;
    }
    if (handle === 'brain' && brain === undefined) {
      errors.push({
        code: 'no_brain',
        message: 'no node on this board is the Brain — address a node by name or @handle',
        span: { start, end },
        handle: typed,
      });
      continue;
    }
    const entry = byHandle.get(handle);
    if (entry === undefined) {
      errors.push({
        code: 'unknown_handle',
        message: `no node is ${typed}`,
        span: { start, end },
        handle: typed,
        suggestions: closestHandles(handle, roster),
      });
      continue;
    }
    spans.push({ start, end, via: 'handle', nodeId: entry.nodeId, text: typed });
  }

  /* 2. Plain names, longest first, never inside a handle. */
  const byName = new Map<string, RosterEntry[]>();
  for (const entry of roster) {
    const key = normalizeName(entry.name);
    if (key === '' || (RESERVED_NAME_WORDS as readonly string[]).includes(key)) continue;
    byName.set(key, [...(byName.get(key) ?? []), entry]);
  }

  interface Candidate {
    start: number;
    end: number;
    entries: RosterEntry[];
  }
  const candidates: Candidate[] = [];
  for (const [key, entries] of byName) {
    const pattern = new RegExp(key.split(' ').map(escapeRegex).join('\\s+'), 'giu');
    for (const match of text.matchAll(pattern)) {
      const start = match.index;
      const end = start + match[0].length;
      if (atNameBoundary(text, start, end)) candidates.push({ start, end, entries });
    }
  }
  candidates.sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start);

  const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }) =>
    a.start < b.end && b.start < a.end;
  const accepted: Candidate[] = [];
  for (const candidate of candidates) {
    if (handleSpans.some((span) => overlaps(span, candidate))) continue;
    if (accepted.some((taken) => overlaps(taken, candidate))) continue;
    accepted.push(candidate);
  }
  for (const candidate of accepted) {
    const typed = text.slice(candidate.start, candidate.end);
    const [only, ...others] = candidate.entries;
    if (only === undefined) continue;
    if (others.length > 0) {
      errors.push({
        code: 'ambiguous_name',
        message: `"${typed}" names more than one node — use ${candidate.entries
          .map((entry) => `@${entry.handle}`)
          .join(' or ')}`,
        span: { start: candidate.start, end: candidate.end },
        handles: candidate.entries.map((entry) => `@${entry.handle}`),
      });
      continue;
    }
    spans.push({
      start: candidate.start,
      end: candidate.end,
      via: 'name',
      nodeId: only.nodeId,
      text: typed,
    });
  }

  spans.sort((a, b) => a.start - b.start);
  errors.sort((a, b) => (a.span?.start ?? 0) - (b.span?.start ?? 0));

  const recipients: Id[] = [];
  for (const span of spans) {
    if (span.nodeId !== undefined && !recipients.includes(span.nodeId))
      recipients.push(span.nodeId);
  }

  if (all && recipients.length > 0) {
    errors.push({
      code: 'all_with_others',
      message: '@all already reaches everyone — send it on its own, or name the nodes you mean',
    });
  }

  return { all, recipients: all ? [] : recipients, spans, errors };
}

/** Node states that mean "finished" to `@all` (D326). */
export const FINISHED_NODE_STATES: readonly NodeState[] = ['COMPLETED', 'FAILED', 'STOPPED'];

export type AddressingMode = 'unaddressed' | 'direct' | 'all';

export interface ResolveAddressingInput {
  parsed: ParsedAddressing;
  roster: readonly RosterEntry[];
  /** Each node's state now; a node with no node run yet is absent. */
  states: Readonly<Record<string, NodeState>>;
  deliveryMode: DeliveryMode;
  /** Recipients the human removed in the preview; each must have been a match. */
  exclude?: readonly Id[];
}

export type ResolvedAddressing =
  | {
      ok: true;
      addressing: AddressingMode;
      recipients: Id[];
      /** `@all` only: nodes it does not reach because they have finished. */
      skipped: { nodeId: Id; reason: 'finished' }[];
    }
  | { ok: false; errors: AddressingError[] };

/**
 * Turn a parse into the message's final recipients (D304, D324, D326) — the server's authority and
 * the composer's preview, from one function. Nothing addressed (or every match removed) goes to the
 * Brain; `@all` reaches every node that has not finished and is queue-only.
 */
export function resolveAddressing(input: ResolveAddressingInput): ResolvedAddressing {
  const { parsed, roster, states, deliveryMode } = input;
  if (parsed.errors.length > 0) return { ok: false, errors: parsed.errors };

  let matched: Id[];
  const skipped: { nodeId: Id; reason: 'finished' }[] = [];
  if (parsed.all) {
    if (deliveryMode === 'interrupt') {
      return {
        ok: false,
        errors: [
          {
            code: 'all_queue_only',
            message: '@all is queue-only — it rides each node’s next turn and never interrupts one',
          },
        ],
      };
    }
    matched = [];
    for (const entry of roster) {
      const state = states[entry.nodeId];
      if (state !== undefined && FINISHED_NODE_STATES.includes(state)) {
        skipped.push({ nodeId: entry.nodeId, reason: 'finished' });
      } else {
        matched.push(entry.nodeId);
      }
    }
    if (matched.length === 0) {
      return {
        ok: false,
        errors: [
          {
            code: 'all_finished',
            message: 'all nodes are done — name the ones you want to redo',
          },
        ],
      };
    }
  } else {
    matched = [...parsed.recipients];
  }

  const exclude = input.exclude ?? [];
  const notMatched = exclude.filter((nodeId) => !matched.includes(nodeId));
  if (notMatched.length > 0) {
    return {
      ok: false,
      errors: notMatched.map((nodeId) => ({
        code: 'exclude_not_matched' as const,
        message: 'that node was not addressed by this message, so it cannot be removed',
        nodeId,
      })),
    };
  }
  const recipients = matched.filter((nodeId) => !exclude.includes(nodeId));

  if (recipients.length > 0) {
    return { ok: true, addressing: parsed.all ? 'all' : 'direct', recipients, skipped };
  }

  const brain = roster.find((entry) => entry.brain);
  if (brain === undefined) {
    return {
      ok: false,
      errors: [{ code: 'no_brain', message: 'address a node by name or @handle' }],
    };
  }
  return { ok: true, addressing: 'unaddressed', recipients: [brain.nodeId], skipped: [] };
}

/* -------------------------------------------------------------------------- */
/* Run config (D312) and the vocabulary of turns, envelopes and routing        */
/* -------------------------------------------------------------------------- */

export const ROUTING_MODES = ['supervised', 'manual'] as const;
export const RoutingModeSchema = z.enum(ROUTING_MODES);
export type RoutingMode = z.infer<typeof RoutingModeSchema>;

export const DEFAULT_LOOP_GUARD_LIMIT = 3;
export const MESSAGE_TEXT_MAX = 8_000;
export const ENVELOPE_SUMMARY_MAX = 400;
/** D327: an agent message with no envelope summary shows this many characters of its output. */
export const AUTO_EXCERPT_CHARS = 280;

/** A run's Domain settings, as recorded in `run.config` and on the run. */
export const RunDomainConfigSchema = z.strictObject({
  routing: RoutingModeSchema,
  loopGuardLimit: z.number().int().min(1).max(50),
  /** Input + output tokens, cached input included (D313); null = no budget. */
  tokenBudget: z.number().int().positive().nullable(),
  /** Started from Domain: the run parks instead of ending when its graph finishes (D323). */
  stayOpen: z.boolean(),
});
export type RunDomainConfig = z.infer<typeof RunDomainConfigSchema>;

/** What a start request may say; everything has a default. */
export const RunDomainConfigInputSchema = z.object({
  routing: RoutingModeSchema.default('supervised'),
  loopGuardLimit: z.number().int().min(1).max(50).default(DEFAULT_LOOP_GUARD_LIMIT),
  tokenBudget: z.number().int().positive().nullable().default(null),
  stayOpen: z.boolean().default(false),
});
export type RunDomainConfigInput = z.input<typeof RunDomainConfigInputSchema>;

/** The config of a run that never said: board-started, supervised, no budget. */
export const defaultRunDomainConfig = (): RunDomainConfig => ({
  routing: 'supervised',
  loopGuardLimit: DEFAULT_LOOP_GUARD_LIMIT,
  tokenBudget: null,
  stayOpen: false,
});

export const BLOCKED_REASONS = ['LOOP_GUARD', 'BUDGET_EXCEEDED'] as const;
export const BlockedReasonSchema = z.enum(BLOCKED_REASONS);
export type BlockedReason = z.infer<typeof BlockedReasonSchema>;

export const TURN_TRIGGER_KINDS = ['dispatch', 'envelope', 'instruction'] as const;
export const TurnTriggerKindSchema = z.enum(TURN_TRIGGER_KINDS);
export type TurnTriggerKind = z.infer<typeof TurnTriggerKindSchema>;

/** Why a turn started (D309): what the RUNNING frame and the node run carry. */
export const TurnTriggerSchema = z.strictObject({
  kind: TurnTriggerKindSchema,
  /** The human messages delivered in this turn. */
  messageIds: z.array(IdSchema).optional(),
  /** The envelopes delivered in this turn. */
  envelopeIds: z.array(IdSchema).optional(),
});
export type TurnTrigger = z.infer<typeof TurnTriggerSchema>;

export const INSTRUCTION_STATES = ['PENDING', 'DELIVERED', 'DONE', 'DROPPED'] as const;
export const InstructionStateSchema = z.enum(INSTRUCTION_STATES);
export type InstructionState = z.infer<typeof InstructionStateSchema>;

export const ENVELOPE_KINDS = ['HANDOFF', 'QUERY', 'ANSWER', 'FLAG'] as const;
export const EnvelopeKindSchema = z.enum(ENVELOPE_KINDS);
export type EnvelopeKind = z.infer<typeof EnvelopeKindSchema>;

export const ROUTING_DECISIONS = ['FORWARDED', 'HELD', 'REJECTED', 'EDITED'] as const;
export const RoutingDecisionSchema = z.enum(ROUTING_DECISIONS);
export type RoutingDecision = z.infer<typeof RoutingDecisionSchema>;

export const ROUTED_BY = ['brain', 'human'] as const;
export const RoutedBySchema = z.enum(ROUTED_BY);
export type RoutedBy = z.infer<typeof RoutedBySchema>;

export const TEXT_SOURCES = ['summary', 'auto'] as const;
export const TextSourceSchema = z.enum(TEXT_SOURCES);
export type TextSource = z.infer<typeof TextSourceSchema>;

/** A file a turn produced (D307). `commit` stays null until checkpoints exist. */
export const ArtifactRefSchema = z.strictObject({
  path: z.string().min(1),
  bytes: z.number().int().min(0).nullable(),
  commit: z.string().min(1).nullable(),
  artifactId: IdSchema.optional(),
});
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;

/**
 * What an agent writes inside a fenced ```ace-envelope block (D310). `to` holds handles, with or
 * without their `@`. The summary is required and short: it is the line the team reads.
 */
export const EnvelopeBlockSchema = z.strictObject({
  kind: EnvelopeKindSchema,
  to: z.array(z.string().min(1)).min(1),
  summary: z.string().trim().min(1).max(ENVELOPE_SUMMARY_MAX),
  inReplyTo: IdSchema.optional(),
});
export type EnvelopeBlock = z.infer<typeof EnvelopeBlockSchema>;

/* -------------------------------------------------------------------------- */
/* Event payloads (D303) — events.ts puts them in the run family               */
/* -------------------------------------------------------------------------- */

export const HUMAN_MESSAGE_ADDRESSING = ['goal', 'unaddressed', 'direct', 'all'] as const;
export const HumanMessageAddressingSchema = z.enum(HUMAN_MESSAGE_ADDRESSING);
export type HumanMessageAddressing = z.infer<typeof HumanMessageAddressingSchema>;

export const MENTION_VIAS = ['name', 'handle', 'all', 'unaddressed'] as const;

/** One final recipient of a human message, as the server resolved it (D324). */
export const HumanMentionSchema = z.strictObject({
  nodeId: IdSchema,
  handle: HandleSchema,
  via: z.enum(MENTION_VIAS),
});
export type HumanMention = z.infer<typeof HumanMentionSchema>;

/**
 * HUMAN_MESSAGE. `mentions` are the final recipients: the Brain for an unaddressed message, none
 * for the goal (which every node reads in `## Team goal`, D311). The text is secret-masked.
 */
export const HumanMessagePayloadSchema = z.strictObject({
  runId: IdSchema,
  messageId: IdSchema,
  text: z.string().min(1).max(MESSAGE_TEXT_MAX),
  addressing: HumanMessageAddressingSchema,
  mentions: z.array(HumanMentionSchema),
  deliveryMode: DeliveryModeSchema,
  exclude: z.array(IdSchema).optional(),
});
export type HumanMessagePayload = z.infer<typeof HumanMessagePayloadSchema>;

/** INSTRUCTION_STATE: one recipient's copy of a human message moved (D309). */
export const InstructionStatePayloadSchema = z.strictObject({
  runId: IdSchema,
  messageId: IdSchema,
  nodeId: IdSchema,
  state: InstructionStateSchema,
  /** DELIVERED and DONE: the turn that carried it. */
  nodeRunId: IdSchema.optional(),
});
export type InstructionStatePayload = z.infer<typeof InstructionStatePayloadSchema>;

/** ENVELOPE_SENT (D310): one envelope a turn produced, explicit or the implicit HANDOFF. */
export const EnvelopeSentPayloadSchema = z.strictObject({
  runId: IdSchema,
  envelopeId: IdSchema,
  nodeRunId: IdSchema,
  kind: EnvelopeKindSchema,
  fromNodeId: IdSchema,
  toNodeIds: z.array(IdSchema),
  /** The agent's summary, or the auto excerpt of the output (`textSource`). */
  summary: z.string().max(ENVELOPE_SUMMARY_MAX),
  textSource: TextSourceSchema,
  inReplyTo: IdSchema.optional(),
  artifacts: z.array(ArtifactRefSchema),
});
export type EnvelopeSentPayload = z.infer<typeof EnvelopeSentPayloadSchema>;

/** ENVELOPE_ROUTED (D310): what the Brain's router or the human did with an envelope. */
export const EnvelopeRoutedPayloadSchema = z.strictObject({
  runId: IdSchema,
  envelopeId: IdSchema,
  decision: RoutingDecisionSchema,
  by: RoutedBySchema,
  reason: z.string().max(ENVELOPE_SUMMARY_MAX).optional(),
  /** EDITED: the version forwarded; the original stays on `envelope.sent` (both are logged). */
  edit: z
    .strictObject({
      kind: EnvelopeKindSchema.optional(),
      toNodeIds: z.array(IdSchema).min(1).optional(),
      summary: z.string().trim().min(1).max(ENVELOPE_SUMMARY_MAX).optional(),
    })
    .optional(),
});
export type EnvelopeRoutedPayload = z.infer<typeof EnvelopeRoutedPayloadSchema>;

/** A turn killed by an interrupting message (D309): what it had written, never handed off. */
export const NodeInterruptedPayloadSchema = z.strictObject({
  runId: IdSchema,
  nodeRunId: IdSchema,
  nodeId: IdSchema,
  messageId: IdSchema,
  partialOutput: z.array(PartSchema),
});
export type NodeInterruptedPayload = z.infer<typeof NodeInterruptedPayloadSchema>;

export const TOKEN_BUDGET_LEVELS = ['SET', 'WARN', 'EXCEEDED'] as const;
export const TokenBudgetLevelSchema = z.enum(TOKEN_BUDGET_LEVELS);
export type TokenBudgetLevel = z.infer<typeof TokenBudgetLevelSchema>;

/** BUDGET (D313): the limit was set or changed, or crossed 80 % or 100 %. */
export const RunTokenBudgetPayloadSchema = z.strictObject({
  runId: IdSchema,
  limit: z.number().int().positive().nullable(),
  used: z.number().int().min(0),
  level: TokenBudgetLevelSchema,
});
export type RunTokenBudgetPayload = z.infer<typeof RunTokenBudgetPayloadSchema>;

/** The run's Domain settings, recorded once at start (D312). */
export const RunConfigPayloadSchema = z.strictObject({
  runId: IdSchema,
  config: RunDomainConfigSchema,
});
export type RunConfigPayload = z.infer<typeof RunConfigPayloadSchema>;

/** RUNNING → BLOCKED mid-run (D305); `run.resumed` ends it. */
export const RunBlockedPayloadSchema = z.strictObject({
  runId: IdSchema,
  reason: BlockedReasonSchema,
  detail: z.string(),
  /** LOOP_GUARD: the two nodes that kept going back and forth. */
  nodeIds: z.array(IdSchema).optional(),
});
export type RunBlockedPayload = z.infer<typeof RunBlockedPayloadSchema>;

/** A Domain-started run whose graph has nothing left to do: open, idle, costing nothing (D323). */
export const RunParkedPayloadSchema = z.strictObject({
  runId: IdSchema,
  /** How the graph would have ended: COMPLETE, or HALTED `failure`. */
  graph: z.enum(['complete', 'failed']),
});
export type RunParkedPayload = z.infer<typeof RunParkedPayloadSchema>;

/* -------------------------------------------------------------------------- */
/* Projected shapes (D303, D327)                                               */
/* -------------------------------------------------------------------------- */

export const DOMAIN_AUTHOR_KINDS = ['human', 'node', 'brain', 'system'] as const;
export const DOMAIN_MESSAGE_TYPES = ['human', 'agent', 'envelope', 'brain', 'system'] as const;
/** RUNNING and WAITING are a turn still under way; the rest are how a turn ended (D309). */
export const TURN_OUTCOMES = [
  'RUNNING',
  'WAITING',
  'OK',
  'INTERRUPTED',
  'FAILED',
  'STOPPED',
] as const;
export const TurnOutcomeSchema = z.enum(TURN_OUTCOMES);
export type TurnOutcome = z.infer<typeof TurnOutcomeSchema>;

/** A cursor is `<seq>.<index>`: the event that created the message, and its place among siblings. */
export const DOMAIN_CURSOR_REGEX = /^\d+\.\d+$/;
export const DomainCursorSchema = z
  .string()
  .regex(DOMAIN_CURSOR_REGEX, 'a cursor is <seq>.<index>');

export const DomainTurnStepSchema = z.strictObject({
  id: z.string(),
  label: z.string(),
  status: z.string(),
  durationMs: z.number().int().min(0).optional(),
  at: TimestampSchema,
});
export type DomainTurnStep = z.infer<typeof DomainTurnStepSchema>;

export const DomainTurnSchema = z.strictObject({
  turnId: IdSchema,
  trigger: TurnTriggerKindSchema,
  iteration: z.number().int().min(1),
  attempt: z.number().int().min(1),
  steps: z.array(DomainTurnStepSchema),
  durationMs: z.number().int().min(0).optional(),
  outcome: TurnOutcomeSchema,
  failureReason: FailureReasonSchema.optional(),
  error: z.string().optional(),
});
export type DomainTurn = z.infer<typeof DomainTurnSchema>;

export const DomainRoutingStepSchema = z.strictObject({
  decision: RoutingDecisionSchema,
  by: RoutedBySchema,
  reason: z.string().optional(),
  at: TimestampSchema,
});
export type DomainRoutingStep = z.infer<typeof DomainRoutingStepSchema>;

export const DomainEnvelopeRefSchema = z.strictObject({
  id: IdSchema,
  kind: EnvelopeKindSchema,
  from: IdSchema,
  inReplyTo: IdSchema.optional(),
  /** The latest decision; absent while nobody has decided (it is on its way). */
  routing: RoutingDecisionSchema.optional(),
  history: z.array(DomainRoutingStepSchema),
  /** Set when the human edited it: what the agent wrote, before the edit. */
  original: z
    .strictObject({ kind: EnvelopeKindSchema, to: z.array(IdSchema), summary: z.string() })
    .optional(),
});
export type DomainEnvelopeRef = z.infer<typeof DomainEnvelopeRefSchema>;

export const DomainDeliverySchema = z.strictObject({
  nodeId: IdSchema,
  state: InstructionStateSchema,
});
export type DomainDelivery = z.infer<typeof DomainDeliverySchema>;

/** One message of a run's conversation (the design's ChatMessage). */
export const DomainMessageSchema = z.strictObject({
  id: z.string().min(1),
  runId: IdSchema,
  cursor: DomainCursorSchema,
  author: z.strictObject({
    kind: z.enum(DOMAIN_AUTHOR_KINDS),
    /** The node that spoke — or, on a system message, the node it is about. */
    nodeId: IdSchema.optional(),
  }),
  type: z.enum(DOMAIN_MESSAGE_TYPES),
  text: z.string(),
  textSource: TextSourceSchema.optional(),
  to: z.array(IdSchema).optional(),
  envelope: DomainEnvelopeRefSchema.optional(),
  turn: DomainTurnSchema.optional(),
  /** The turn's full output, for expanding an agent message (D327). */
  output: z.array(PartSchema).optional(),
  artifacts: z.array(ArtifactRefSchema).optional(),
  delivery: z.array(DomainDeliverySchema).optional(),
  level: z.enum(['info', 'warn', 'error']).optional(),
  at: TimestampSchema,
});
export type DomainMessage = z.infer<typeof DomainMessageSchema>;

export const USAGE_SOURCES = ['reported', 'estimated'] as const;
export const UsageSourceSchema = z.enum(USAGE_SOURCES);
export type UsageSource = z.infer<typeof UsageSourceSchema>;

export const DomainCostSchema = z.strictObject({
  usd: z.number().min(0),
  /** Reported by the provider, estimated from `ace.pricing.json`, or a mix (D306). */
  source: z.enum(['reported', 'estimated', 'mixed']),
  /** Some turns had no price at all, so this is a floor. */
  partial: z.boolean(),
});
export type DomainCost = z.infer<typeof DomainCostSchema>;

const tokens = z.number().int().min(0);

export const DomainUsageSnapshotSchema = z.strictObject({
  runId: IdSchema,
  budget: z
    .strictObject({
      limit: z.number().int().positive(),
      used: tokens,
      level: z.enum(['OK', 'WARN', 'EXCEEDED']),
    })
    .nullable(),
  total: z.strictObject({
    input: tokens,
    output: tokens,
    cachedInput: tokens,
    /** The share of the tokens that are estimates, 0..1 (D313). */
    estimatedShare: z.number().min(0).max(1),
  }),
  costEst: DomainCostSchema.nullable(),
  perNode: z.array(
    z.strictObject({
      nodeId: IdSchema,
      handle: HandleSchema,
      name: z.string(),
      brain: z.boolean(),
      state: NodeStateSchema,
      activity: z.string(),
      input: tokens,
      output: tokens,
      /** Null for a node that has not taken a turn. */
      source: z.enum(['reported', 'estimated', 'mixed']).nullable(),
      costEst: DomainCostSchema.nullable(),
      /** This node's tokens as a share of the budget, 0..; null without a budget. */
      budgetShare: z.number().min(0).nullable(),
    }),
  ),
  perTurn: z.array(
    z.strictObject({
      turnId: IdSchema,
      nodeId: IdSchema,
      input: tokens,
      output: tokens,
      source: UsageSourceSchema,
      costEst: DomainCostSchema.nullable(),
    }),
  ),
});
export type DomainUsageSnapshot = z.infer<typeof DomainUsageSnapshotSchema>;

/* -------------------------------------------------------------------------- */
/* HTTP and SSE (D314)                                                         */
/* -------------------------------------------------------------------------- */

export const DOMAIN_PAGE_MAX = 500;
export const DOMAIN_PAGE_DEFAULT = 200;

/** `GET /runs/:runId/chat?node=&after=&limit=`. */
export const DomainChatQuerySchema = z.object({
  node: IdSchema.optional(),
  after: DomainCursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(DOMAIN_PAGE_MAX).optional(),
});
export type DomainChatQuery = z.infer<typeof DomainChatQuerySchema>;

export const DomainChatPageSchema = z.strictObject({
  messages: z.array(DomainMessageSchema),
  nextCursor: DomainCursorSchema.optional(),
});
export type DomainChatPage = z.infer<typeof DomainChatPageSchema>;

/** `POST /runs/:runId/messages` (D324). */
export const PostRunMessageRequestSchema = z.strictObject({
  text: z.string().trim().min(1).max(MESSAGE_TEXT_MAX),
  deliveryMode: DeliveryModeSchema.default('queue'),
  exclude: z.array(IdSchema).optional(),
});
export type PostRunMessageRequest = z.input<typeof PostRunMessageRequestSchema>;

export const PostRunMessageResponseSchema = z.strictObject({
  messageId: IdSchema,
  delivery: z.array(DomainDeliverySchema),
});
export type PostRunMessageResponse = z.infer<typeof PostRunMessageResponseSchema>;

/** `POST /runs/:runId/envelopes/:id/route` — the human's decision on a HELD envelope (D310). */
export const RouteEnvelopeRequestSchema = z.strictObject({
  decision: z.enum(['approve', 'reject', 'edit']),
  reason: z.string().max(ENVELOPE_SUMMARY_MAX).optional(),
  edit: z
    .strictObject({
      kind: EnvelopeKindSchema.optional(),
      to: z.array(z.string().min(1)).min(1).optional(),
      summary: z.string().trim().min(1).max(ENVELOPE_SUMMARY_MAX).optional(),
    })
    .optional(),
});
export type RouteEnvelopeRequest = z.infer<typeof RouteEnvelopeRequestSchema>;

/** `PUT /runs/:runId/budget` (D313). `null` removes the budget. */
export const PutRunBudgetRequestSchema = z.strictObject({
  limit: z.number().int().positive().nullable(),
});
export type PutRunBudgetRequest = z.infer<typeof PutRunBudgetRequestSchema>;

/**
 * The SSE frames of `GET /runs/:runId/chat/stream` (D314). Not WebSocket frames: they never join
 * `ServerFrameSchema`. `chat.update` replaces an existing message by id; `turn.token` is live text
 * with no id, so a reconnect skips it and the turn's message carries the result.
 */
export const DomainStreamFrameSchema = z.discriminatedUnion('event', [
  z.strictObject({
    event: z.literal('chat.message'),
    data: z.strictObject({ message: DomainMessageSchema }),
  }),
  z.strictObject({
    event: z.literal('chat.update'),
    data: z.strictObject({ message: DomainMessageSchema }),
  }),
  z.strictObject({
    event: z.literal('usage.snapshot'),
    data: z.strictObject({ snapshot: DomainUsageSnapshotSchema }),
  }),
  z.strictObject({
    event: z.literal('turn.token'),
    data: z.strictObject({ nodeRunId: IdSchema, nodeId: IdSchema, delta: z.string() }),
  }),
]);
export type DomainStreamFrame = z.infer<typeof DomainStreamFrameSchema>;

/* -------------------------------------------------------------------------- */
/* ace.pricing.json (D306)                                                     */
/* -------------------------------------------------------------------------- */

/** One model's price, per 1M tokens, keyed by provider type and model id. */
export const PricingEntrySchema = z.strictObject({
  provider: ProviderTypeSchema,
  model: z.string().min(1),
  inputPer1M: z.number().min(0),
  outputPer1M: z.number().min(0),
});
export type PricingEntry = z.infer<typeof PricingEntrySchema>;

/** `<dataDir>/ace.pricing.json`. It ships empty; a missing model costs null, never 0. */
export const PricingTableSchema = z.strictObject({ models: z.array(PricingEntrySchema) });
export type PricingTable = z.infer<typeof PricingTableSchema>;

export const emptyPricingTable = (): PricingTable => ({ models: [] });
