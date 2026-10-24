import type { ChatVerdict, Id } from '@ace/contracts';

import type { RouteRefusalCode } from '../ports/index.js';

/**
 * The chat service's own errors (round 4 §2.3, FR-CHAT-004..008).
 *
 * They are thrown, not returned, so the gateway maps each to a status: a missing workflow, node or
 * thread is a 404; a node that is not an agent is a 422 `invalid_config`; a model the router refuses
 * is a 422 with the router's code; and a guardrail that blocks the chat *input* is the 422
 * `guardrail_blocked` FR-CHAT-008 names, carrying the verdicts that say why. A blocked *reply* is
 * not an error — it comes back as a `chat.message` whose content is `[blocked by guardrail: …]`.
 */

export class ChatWorkflowNotFoundError extends Error {
  override readonly name = 'ChatWorkflowNotFoundError';

  constructor(readonly workflowId: Id) {
    super(`Workflow ${workflowId} was not found.`);
  }
}

export class ChatNodeNotFoundError extends Error {
  override readonly name = 'ChatNodeNotFoundError';

  constructor(readonly nodeId: Id) {
    super(`Node ${nodeId} was not found.`);
  }
}

export class ChatThreadNotFoundError extends Error {
  override readonly name = 'ChatThreadNotFoundError';

  constructor(readonly threadId: Id) {
    super(`Chat thread ${threadId} was not found.`);
  }
}

/** A node whose kind has no direct chat — only `agent` and `model` nodes do (round 4 §2.3). */
export class NotAnAgentNodeError extends Error {
  override readonly name = 'NotAnAgentNodeError';

  constructor(readonly nodeId: Id) {
    super(`Node ${nodeId} is not an agent or model node, so it has no direct chat.`);
  }
}

/** A thread named on `POST /nodes/:id/chat` that belongs to a different node (round 4 §2.3). */
export class ChatThreadNodeMismatchError extends Error {
  override readonly name = 'ChatThreadNodeMismatchError';

  constructor(
    readonly threadId: Id,
    readonly nodeId: Id,
  ) {
    super(`Chat thread ${threadId} does not belong to node ${nodeId}.`);
  }
}

/**
 * D302: a `targetNodeId` that cannot answer in this thread — no such node, a node of another
 * workflow, or one that is not an agent or model node. The gateway maps it to **400
 * `validation_failed`**.
 */
export class ChatTargetInvalidError extends Error {
  override readonly name = 'ChatTargetInvalidError';

  constructor(
    readonly targetNodeId: Id,
    reason: string,
  ) {
    super(reason);
  }
}

/**
 * D405: `@debate` from a node with no debate edge, or one whose ends cannot answer in chat. The
 * gateway maps it to **400 `validation_failed`**, saying what to connect.
 */
export class ChatDebateUnavailableError extends Error {
  override readonly name = 'ChatDebateUnavailableError';

  constructor(reason: string) {
    super(reason);
  }
}

/** The router refused to pick a model for this chat (same codes as a run's pre-flight). */
export class ChatModelError extends Error {
  override readonly name = 'ChatModelError';

  constructor(
    readonly code: RouteRefusalCode,
    reason: string,
  ) {
    super(reason);
  }
}

/**
 * The chat input was blocked by the agent's guardrail policy (FR-CHAT-008, TC-GRD-022). The gateway
 * maps it to **422 `guardrail_blocked`** with `details.verdicts`.
 */
export class ChatInputBlockedError extends Error {
  override readonly name = 'ChatInputBlockedError';

  constructor(
    readonly verdicts: ChatVerdict[],
    reason: string,
  ) {
    super(reason);
  }
}

/** PG-1.6 (D352): a message action named a message that is not in the thread (or was deleted). */
export class ChatMessageNotFoundError extends Error {
  override readonly name = 'ChatMessageNotFoundError';

  constructor(
    readonly threadId: Id,
    readonly messageId: Id,
  ) {
    super(`Message ${messageId} was not found in chat thread ${threadId}.`);
  }
}

/**
 * PG-1.6 (D352): a message action the message cannot take — an edit of an agent turn, a retry of a
 * turn with no question before it, an action on a turn already replaced. The gateway maps it to
 * **400 `validation_failed`**.
 */
export class ChatActionInvalidError extends Error {
  override readonly name = 'ChatActionInvalidError';

  constructor(reason: string) {
    super(reason);
  }
}

/** PG-2.2 (D359): no chat approval with this id is waiting on the thread (gone, or decided). */
export class ChatApprovalNotFoundError extends Error {
  override readonly name = 'ChatApprovalNotFoundError';

  constructor(
    readonly threadId: Id,
    readonly requestId: Id,
  ) {
    super(`Chat thread ${threadId} has no approval ${requestId} waiting for a decision.`);
  }
}

/** `POST /workflows/:id/messages { run: true }` on a service built without a run starter (see report). */
export class ChatRunNotAvailableError extends Error {
  override readonly name = 'ChatRunNotAvailableError';

  constructor() {
    super('This engine cannot start a run from a posted message.');
  }
}
