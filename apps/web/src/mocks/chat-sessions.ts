import type { ChatMessage, NodeError, Part, Run } from '@ace/contracts';

import { newId } from '../lib/ulid';
import type { MockDb } from './db';

/**
 * D285 in the mock engine: when a goal-driven node (an Agent, or a bare Model) finishes a run, its
 * goal and its result — or its failure — are written into the node's chat session, before the
 * node's final state goes out. It is what the engine's run service does through `recordNodeTurn`,
 * so the chat column behaves the same against the mock as against the real engine.
 *
 * The session is the thread the node was last talked to in, or a new one named after the goal.
 */
export function recordMockRunTurn(
  db: MockDb,
  run: Run,
  payload: { nodeId?: unknown; nodeRunId?: unknown; status?: unknown },
): void {
  const { nodeId, nodeRunId, status } = payload;
  if (typeof nodeId !== 'string' || typeof nodeRunId !== 'string') return;
  if (status !== 'COMPLETED' && status !== 'FAILED' && status !== 'BLOCKED') return;

  const node = run.snapshot.nodes.find((each) => each.id === nodeId);
  if (node === undefined || (node.kind !== 'agent' && node.kind !== 'model')) return;

  const nodeRun = db.getNodeRun(nodeRunId);
  // BLOCKED without an error of its own is "an upstream failed": nothing of this node ran.
  if (status === 'BLOCKED' && nodeRun?.error === undefined) return;

  const goal = (
    node.kind === 'agent' ? node.config.instructions : (node.config.systemPrompt ?? '')
  ).trim();
  const at = new Date().toISOString();

  const thread =
    db.chatThreadsOf(node.id)[0] ??
    db.addChatThread({
      id: newId(),
      nodeId: node.id,
      title: (goal === '' ? 'Run' : goal).slice(0, 60),
      createdAt: at,
      updatedAt: at,
    });

  const asked: Part[] = [{ type: 'text', text: goal === '' ? 'Run' : goal }];
  const failure: NodeError | undefined =
    status === 'COMPLETED'
      ? undefined
      : (nodeRun?.error ?? {
          kind: 'workflow',
          code: 'node_failed',
          message: `"${node.name}" did not finish.`,
          retryable: false,
        });

  const turns: ChatMessage[] = [
    {
      id: newId(),
      threadId: thread.id,
      role: 'user',
      content: asked,
      verdicts: [],
      at,
      runId: run.id,
    },
    failure === undefined
      ? {
          id: newId(),
          threadId: thread.id,
          role: 'agent',
          content: nodeRun?.output ?? [],
          verdicts: [],
          at,
          runId: run.id,
          ...(nodeRun?.usage === undefined ? {} : { usage: nodeRun.usage }),
        }
      : {
          id: newId(),
          threadId: thread.id,
          role: 'agent',
          content: [{ type: 'text', text: failure.message }],
          verdicts: [],
          at,
          runId: run.id,
          error: failure,
        },
  ];

  for (const message of turns) {
    db.addChatMessage(message);
    db.emit({
      type: 'chat.message',
      payload: { threadId: thread.id, message },
      scope: 'thread',
      threadId: thread.id,
    });
  }
}
