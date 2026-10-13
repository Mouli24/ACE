import type { QueryClient } from '@tanstack/react-query';

import { api } from '../../app/api';
import { useLayoutStore } from '../../app/stores/layout';
import { usePanelsStore } from '../../app/stores/panels';
import { chipPart, useComposerChips, type ChipSource } from '../../chat/composer-chips';
import { sendToNode } from '../../chat/useChat';
import { isChatNodeOf } from '../../chat/workflow-target';
import { askAgentAbout } from '../ask-agent';
import { languageOf } from '../editor/languages';
import { getModel } from '../editor/models';

/**
 * Fix with agent (D302, design §6.5): one click hands a problem — from Monaco's markers or, after
 * the merge, from Run checks — to the chat's current node: what is wrong and where, with the
 * file's lines around it as a `code` part. With no node selected it waits in the composer instead,
 * for the person to pick one — and so it does when the chat's node is not one of Forge's workflow
 * (fix F-I2): a target left over from another workflow or project is never sent to.
 */

/** Lines either side of the problem's line that travel with it. */
export const FIX_CONTEXT_LINES = 5;

/** The problem as a fix request needs it — a Problems row, or a check result. */
export interface FixableProblem {
  path: string;
  line: number;
  message: string;
  source?: string | undefined;
}

/** The line and `radius` lines either side, clipped at the file's ends. */
export function problemContext(
  text: string,
  line: number,
  radius = FIX_CONTEXT_LINES,
): { startLine: number; endLine: number; text: string } {
  const lines = text.split(/\r\n|\n/);
  const at = Math.min(Math.max(1, line), lines.length);
  const startLine = Math.max(1, at - radius);
  const endLine = Math.min(lines.length, at + radius);
  return { startLine, endLine, text: lines.slice(startLine - 1, endLine).join('\n') };
}

/** "Fix this problem: <message> (<source>)". */
export function fixMessage(problem: Pick<FixableProblem, 'message' | 'source'>): string {
  const source =
    problem.source === undefined || problem.source === '' ? '' : ` (${problem.source})`;
  return `Fix this problem: ${problem.message}${source}`;
}

/** The file's text: the open model's, else the disk's; undefined when it cannot be read. */
async function textOf(projectId: string, path: string): Promise<string | undefined> {
  const model = getModel(projectId, path);
  if (model !== undefined) return model.getValue();
  try {
    const file = await api().readFile(projectId, path);
    return file.kind === 'text' ? file.content : undefined;
  } catch {
    return undefined;
  }
}

export async function fixWithAgent(input: {
  projectId: string;
  /** Forge's workflow: only a chat node of its graph is sent to directly. */
  workflowId?: string | undefined;
  problem: FixableProblem;
  queryClient: QueryClient;
}): Promise<'sent' | 'prefilled'> {
  const { projectId, problem } = input;
  const text = await textOf(projectId, problem.path);
  const language = languageOf(problem.path);
  const context = text === undefined ? undefined : problemContext(text, problem.line);
  const chip: ChipSource =
    context === undefined
      ? { path: problem.path, language }
      : { path: problem.path, language, ...context };
  const message = fixMessage(problem);

  const nodeId = usePanelsStore.getState().chatNodeId;
  if (nodeId === undefined || !isChatNodeOf(input.queryClient, input.workflowId, nodeId)) {
    useComposerChips.getState().prefill(message);
    askAgentAbout(chip);
    return 'prefilled';
  }
  // The chat column comes into view to show the reply.
  if (!useLayoutStore.getState().chatOpen) useLayoutStore.getState().toggleChat();
  await sendToNode(input.queryClient, nodeId, [{ type: 'text', text: message }, chipPart(chip)]);
  return 'sent';
}
