import type { ChatMessage, DataType, Envelope, Part } from '@ace/contracts';

import { CHARS_PER_TOKEN, estimateTokens } from '../envelopes/index.js';
import { assemblePrompt, type AssembledPrompt } from '../prompts/index.js';

/**
 * The prompt a direct chat turn is built from (FR-CHAT-004, FR-PRM-002, Arch §12.5, round 4 §4
 * item 5).
 *
 * It goes through the **same prompt manager** as a run, so the system base, the assembly order and
 * the version scheme are identical (a French-answering agent answers in French because its
 * instructions reach the model unchanged, TC-CHAT-004). What differs is allowed to: a workflow
 * handoff is a bounded envelope with no history (BR-02), but a chat *is* a conversation, so the
 * thread — the earlier turns **and** the new user turn, each labelled with its role — is the
 * prompt's `## Conversation`, inside the node's own bounded context and capped to the agent's
 * `contextPolicy.budgetTokens` (FR-EXE-007), the oldest turns dropped first (D-079).
 *
 * The turns are the user's own words and the agent's own replies, so they are not fenced as
 * untrusted; what is untrusted keeps its label (BR-13, FR-PRM-002): the new turn's attachments are
 * the envelope's reads, and land in the `## Input` block marked untrusted. Tool results, in a
 * project chat (D302), reach the model through the adapter, labelled as a run's are.
 *
 * D302: more than one node can speak in a thread (`@handle`), so each assistant turn is labelled
 * with its speaker's name, and the node answering now sees which turns were its own.
 */

/** `path:L3-L7` for a chip from the editor, `path` for a whole file. */
function placeOf(part: Extract<Part, { type: 'code' }>): string {
  const path = part.path ?? '';
  if (part.startLine === undefined) return path;
  const end =
    part.endLine === undefined || part.endLine === part.startLine ? '' : `-L${part.endLine}`;
  return `${path}:L${part.startLine}${end}`;
}

/** How a part reads inside a conversation transcript — a file is its reference, never its bytes. */
function renderPart(part: Part): string {
  switch (part.type) {
    case 'text':
      return part.text;
    case 'code':
      // D302: a chip from the editor says where its code is from; a bare file chip is only that.
      if (part.path === undefined) return part.text;
      if (part.text === '') return `[file: ${placeOf(part)}]`;
      return `[${placeOf(part)}]\n\`\`\`${part.language}\n${part.text}\n\`\`\``;
    case 'json':
      return JSON.stringify(part.value ?? null);
    default:
      return `[${part.type}: ${part.name}]`;
  }
}

/** One turn of a thread: who said it, and what. */
export type ConversationTurn = Pick<ChatMessage, 'role' | 'content' | 'speakerNodeId'>;

/**
 * Who spoke, by name (D302). An assistant turn without a speaker was the thread's own node's. With
 * no names every assistant turn is just "Assistant", as before.
 */
export interface SpeakerNames {
  /** Node id → name, for the nodes of the thread's workflow. */
  names: ReadonlyMap<string, string>;
  /** The thread's own node: who spoke a turn that names no speaker. */
  mainNodeId: string;
  /** The node answering now: its own turns say so. */
  selfNodeId: string;
}

export function renderTurn(message: ConversationTurn, speakers?: SpeakerNames): string {
  const body = message.content.map(renderPart).join('\n');
  if (message.role === 'user') return `User: ${body}`;
  const speakerId = message.speakerNodeId ?? speakers?.mainNodeId;
  const name = speakerId === undefined ? undefined : speakers?.names.get(speakerId);
  if (name === undefined) return `Assistant: ${body}`;
  return `Assistant (${name}${speakerId === speakers?.selfNodeId ? ', you' : ''}): ${body}`;
}

/**
 * The turns rendered newest-first until the budget is spent, then put back in order. Keeping the
 * most recent turns is what a conversation needs: the tail is the thread the user is continuing,
 * and the opening greeting is the first thing worth dropping when the history outgrows the budget.
 */
export function renderConversation(
  history: readonly ConversationTurn[],
  budgetTokens: number,
  speakers?: SpeakerNames,
): string {
  const kept: string[] = [];
  let spent = 0;

  for (let i = history.length - 1; i >= 0; i -= 1) {
    const line = renderTurn(history[i]!, speakers);
    const cost = estimateTokens(line) + 1; // +1 for the newline that joins it
    if (spent + cost > budgetTokens) break;
    kept.push(line);
    spent += cost;
  }

  kept.reverse();
  const joined = kept.join('\n');

  // A single turn longer than the whole budget is still shown, truncated, rather than dropped: an
  // empty conversation is worse than a clipped one.
  if (joined === '' && history.length > 0) {
    return renderTurn(history[history.length - 1]!, speakers).slice(
      0,
      Math.max(0, budgetTokens * CHARS_PER_TOKEN),
    );
  }
  return joined;
}

/** A part the user wrote — text, code or JSON — as opposed to a file they attached. */
function isWritten(part: Part): boolean {
  return part.type === 'text' || part.type === 'code' || part.type === 'json';
}

export interface BuildChatPromptInput {
  /** A synthetic id for the conversation envelope — never a run (FR-CHAT-005). */
  conversationId: string;
  nodeId: string;
  instructions: string;
  inputTypes: DataType[];
  budgetTokens: number;
  /** The turns before this one, oldest first. */
  history: readonly ChatMessage[];
  /** The new user turn's parts — the turn the model answers. */
  userParts: readonly Part[];
  now: string;
  /** D302: label each assistant turn with its speaker's name. */
  speakers?: SpeakerNames;
  /**
   * D302 R-1: what the engine tells the model ahead of the new turn's own words (the files the
   * person reverted). Part of the turn the model reads, never of the message stored or shown.
   */
  note?: string;
}

/** The most reverted paths one note names; the rest are counted. */
export const REVERT_NOTE_MAX_PATHS = 20;

/** D302 R-1: the note a thread's next turn starts with after the person reverted files. Paths only. */
export function revertedFilesNote(paths: readonly string[]): string {
  const shown = paths.slice(0, REVERT_NOTE_MAX_PATHS);
  const more = paths.length - shown.length;
  return (
    'Note: the person reverted your earlier changes to these files; they are back to how they ' +
    `were before that turn: ${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}. ` +
    'Re-read a file before relying on its contents.'
  );
}

export function buildChatPrompt(input: BuildChatPromptInput): AssembledPrompt {
  const newTurn: ConversationTurn = {
    role: 'user',
    content:
      input.note === undefined
        ? [...input.userParts]
        : [{ type: 'text', text: input.note }, ...input.userParts],
  };
  // The new turn is last, so it is the one the budget keeps longest (and truncates, never drops).
  const transcript = renderConversation(
    [...input.history, newTurn],
    input.budgetTokens,
    input.speakers,
  );
  const latestText = input.userParts
    .filter((part): part is Extract<Part, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n');

  const envelope: Envelope = {
    id: input.conversationId,
    // Not a run: this id names the conversation, and nothing about it is ever written to `runs`.
    runId: input.conversationId,
    fromNodeId: `chat-${input.nodeId}`,
    toNodeId: input.nodeId,
    iteration: 1,
    // Only what was attached: the file's content came from outside the conversation.
    reads: input.userParts.filter((part) => !isWritten(part)),
    context: {
      budgetTokens: input.budgetTokens,
      // BR-13: an attachment is content nobody in the conversation wrote, so it is untrusted.
      trust: 'untrusted',
    },
    contract: { outputTypes: ['text'] },
    createdAt: input.now,
  };

  return assemblePrompt({
    instructions: input.instructions,
    envelopes: [envelope],
    contract: { outputTypes: ['text'] },
    iteration: 1,
    conversation: { transcript, latestText },
    inputLabel: 'Attachments to the latest message',
  });
}
