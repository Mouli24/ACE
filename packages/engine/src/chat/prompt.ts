import type { ChatMessage, DataType, Envelope, Part } from '@ace/contracts';

import { CHARS_PER_TOKEN, estimateTokens } from '../envelopes/index.js';
import { assemblePrompt, type AssembledPrompt } from '../prompts/index.js';

/**
 * The prompt a direct chat turn is built from (FR-CHAT-004, FR-PRM-002, Arch §12.5).
 *
 * It goes through the **same prompt manager** as a run, so the system base, the assembly order and
 * the version scheme are identical (a French-answering agent answers in French because its
 * instructions reach the model unchanged, TC-CHAT-004). What differs is allowed to: a workflow
 * handoff is a bounded envelope with no history (BR-02), but a chat *is* a conversation, so the
 * thread so far is carried as the envelope's context — labelled untrusted, and capped to the
 * agent's `contextPolicy.budgetTokens` the way any context is (FR-EXE-007). The newest user turn is
 * the envelope's reads, which land in the `## Input` section the model answers.
 */

/** How a part reads inside a conversation transcript — a file is its reference, never its bytes. */
function renderPart(part: Part): string {
  switch (part.type) {
    case 'text':
      return part.text;
    case 'code':
      return part.text;
    case 'json':
      return JSON.stringify(part.value ?? null);
    default:
      return `[${part.type}: ${part.name}]`;
  }
}

function renderTurn(message: ChatMessage): string {
  const who = message.role === 'user' ? 'User' : 'Assistant';
  const body = message.content.map(renderPart).join('\n');
  return `${who}: ${body}`;
}

/**
 * The prior turns rendered newest-first until the budget is spent, then put back in order. Keeping
 * the most recent turns is what a conversation needs: the tail is the thread the user is continuing,
 * and the opening greeting is the first thing worth dropping when the history outgrows the budget.
 */
export function renderConversation(history: readonly ChatMessage[], budgetTokens: number): string {
  const kept: string[] = [];
  let spent = 0;

  for (let i = history.length - 1; i >= 0; i -= 1) {
    const line = renderTurn(history[i]!);
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
    return renderTurn(history[history.length - 1]!).slice(0, Math.max(0, budgetTokens * CHARS_PER_TOKEN));
  }
  return joined;
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
  /** The new user turn's parts — the reads the model answers. */
  userParts: readonly Part[];
  now: string;
}

export function buildChatPrompt(input: BuildChatPromptInput): AssembledPrompt {
  const conversation = renderConversation(input.history, input.budgetTokens);

  const envelope: Envelope = {
    id: input.conversationId,
    // Not a run: this id names the conversation, and nothing about it is ever written to `runs`.
    runId: input.conversationId,
    fromNodeId: `chat-${input.nodeId}`,
    toNodeId: input.nodeId,
    iteration: 1,
    reads: [...input.userParts],
    context: {
      ...(conversation === ''
        ? {}
        : { summary: `Conversation so far:\n${conversation}` }),
      budgetTokens: input.budgetTokens,
      // BR-13: a chat turn's history includes model output and pasted content, so it is untrusted.
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
  });
}
