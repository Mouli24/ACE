import type { ChatMessage, Node } from '@ace/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ChatPanel } from './ChatPanel';
import { replyText, sendToBuildInitial, titleFromReply } from './send-to-build';
import { db, installChatMockServer, renderChat, seedAgentNode } from './test-support';

installChatMockServer();

/** ACE parity P1 *Send to Build*: an agent's chat reply becomes a task that knows where it came from. */
describe('ACE-P1 Send to Build from a chat reply', () => {
  it('opens New task prefilled from the reply and creates the task with its chat source', async () => {
    const user = userEvent.setup();
    const { workflowId } = seedAgentNode({ name: 'Writer' });
    renderChat(<ChatPanel workflowId={workflowId} />);

    await waitFor(() => expect(screen.getByTestId('chat-input')).toBeInTheDocument());
    await user.type(screen.getByTestId('chat-input'), 'hello');
    await user.click(screen.getByTestId('chat-send'));
    await waitFor(() =>
      expect(screen.getByTestId('chat-conversation')).toHaveTextContent('You said: hello'),
    );

    // only agent replies can be sent; the user's own turn has no button
    const buttons = await screen.findAllByRole('button', { name: 'Send to Build' });
    expect(buttons).toHaveLength(1);
    await waitFor(() => expect(buttons[0]).toBeEnabled());
    await user.click(buttons[0]!);

    const dialog = await screen.findByRole('dialog', { name: 'New task' });
    expect(within(dialog).getByLabelText('Title')).toHaveValue('You said: hello');
    expect(within(dialog).getByLabelText('Brief')).toHaveValue(
      'You said: hello\n\nFrom a chat with Writer.',
    );
    expect(within(dialog).getByTestId('new-task-source')).toHaveTextContent(
      'From a chat with Writer.',
    );
    await waitFor(() => expect(within(dialog).getByLabelText('Team')).toHaveValue(workflowId));
    await user.click(within(dialog).getByRole('button', { name: 'Add to Inbox' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New task' })).toBeNull());
    const projectId = db.getWorkflow(workflowId)?.projectId ?? '';
    const [task] = db.listTasks(projectId);
    expect(task).toMatchObject({
      title: 'You said: hello',
      workflowId,
      stage: 'inbox',
      source: { kind: 'chat', workflowId, label: 'Writer' },
    });
    expect(task?.source?.threadId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(task?.source?.messageId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(db.taskActivityOf(task?.id ?? '')[0]?.message).toBe('Task created from a chat message.');
  });
});

describe('ACE-P1 Send to Build — the prefill', () => {
  const node = { id: 'n', workflowId: '01ARZ3NDEKTSV4RRFFQ69G5FAW', name: 'Planner' } as Node;
  const message = (text: string, extra: ChatMessage['content'] = []): ChatMessage => ({
    id: '01ARZ3NDEKTSV4RRFFQ69G5FT0',
    threadId: '01ARZ3NDEKTSV4RRFFQ69G5FT1',
    role: 'agent',
    content: [{ type: 'text', text }, ...extra],
    verdicts: [],
    at: '2026-10-07T00:00:00.000Z',
  });

  it('titles the task with the first line, Markdown markers off, at most 120 characters', () => {
    expect(titleFromReply('## Add **accent** folding\nThen tests.', 'x')).toBe(
      'Add accent folding',
    );
    expect(titleFromReply('\n\n- `normalize()` first', 'x')).toBe('normalize() first');
    expect(titleFromReply('a'.repeat(200), 'x')).toHaveLength(120);
    expect(titleFromReply('```ts\ncode\n```', 'Fallback')).toBe('code');
    expect(titleFromReply('   ', 'Follow-up from Planner')).toBe('Follow-up from Planner');
  });

  it('keeps text and code, names the chat, and points the source at the message', () => {
    const initial = sendToBuildInitial(
      node,
      message('Plan:', [{ type: 'code', language: 'ts', text: 'x()' }]),
    );
    expect(replyText(message('Plan:').content)).toBe('Plan:');
    expect(initial).toEqual({
      title: 'Plan:',
      brief: 'Plan:\n\n```ts\nx()\n```\n\nFrom a chat with Planner.',
      workflowId: node.workflowId,
      source: {
        kind: 'chat',
        workflowId: node.workflowId,
        threadId: '01ARZ3NDEKTSV4RRFFQ69G5FT1',
        messageId: '01ARZ3NDEKTSV4RRFFQ69G5FT0',
        label: 'Planner',
      },
    });
    const long = sendToBuildInitial(node, message('y'.repeat(30_000)));
    expect(long.brief?.length).toBeLessThanOrEqual(20_000);
    expect(long.brief?.endsWith('From a chat with Planner.')).toBe(true);
  });
});
