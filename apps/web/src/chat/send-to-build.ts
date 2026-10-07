import { TASK_BRIEF_MAX, type ChatMessage, type Node, type Part } from '@ace/contracts';

import type { NewTaskInitial } from '../tasks/NewTaskDialog';

/** The longest title a reply's first line makes (ACE parity P1, Send to Build). */
export const SEND_TO_BUILD_TITLE_MAX = 120;

/** A reply's words: its text parts, and its code parts fenced as Markdown. */
export function replyText(content: readonly Part[]): string {
  return content
    .map((part) => {
      if (part.type === 'text') return part.text;
      if (part.type === 'code') return `\`\`\`${part.language}\n${part.text}\n\`\`\``;
      return '';
    })
    .filter((text) => text.trim() !== '')
    .join('\n\n')
    .trim();
}

/** The reply's first line as a title: Markdown markers off, at most 120 characters. */
export function titleFromReply(text: string, fallback: string): string {
  const first =
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== '' && !line.startsWith('```')) ?? '';
  const plain = first
    .replace(/^(#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, '')
    .replace(/\*\*|__|`/g, '')
    .trim();
  const title = plain.slice(0, SEND_TO_BUILD_TITLE_MAX).trim();
  return title === '' ? fallback.slice(0, SEND_TO_BUILD_TITLE_MAX) : title;
}

/**
 * *Send to Build*: an agent's reply as the start of a task — its first line the title, the reply
 * (and where it came from) the brief, the chat's workflow the team, and the message as the source,
 * so the task links back and reports its outcome to that workflow.
 */
export function sendToBuildInitial(node: Node, message: ChatMessage): NewTaskInitial {
  const text = replyText(message.content);
  const suffix = `\n\nFrom a chat with ${node.name}.`;
  const brief = `${text.slice(0, TASK_BRIEF_MAX - suffix.length)}${suffix}`.trim();
  return {
    title: titleFromReply(text, `Follow-up from ${node.name}`),
    brief,
    workflowId: node.workflowId,
    source: {
      kind: 'chat',
      workflowId: node.workflowId,
      threadId: message.threadId,
      messageId: message.id,
      label: node.name.slice(0, 400),
    },
  };
}
