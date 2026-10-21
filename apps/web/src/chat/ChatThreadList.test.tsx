import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ChatPanel } from './ChatPanel';
import { db, installChatMockServer, renderChat, seedAgentNode } from './test-support';

installChatMockServer();

describe('FR-CHAT-004 thread list: new, select and delete', () => {
  it('opens a thread on the first send and lists it', async () => {
    const user = userEvent.setup();
    const { workflowId, node } = seedAgentNode();
    renderChat(<ChatPanel workflowId={workflowId} />);

    await waitFor(() => expect(screen.getByTestId('chat-input')).toBeInTheDocument());
    await user.type(screen.getByTestId('chat-input'), 'first conversation');
    await user.click(screen.getByTestId('chat-send'));

    await waitFor(() => expect(db.chatThreadsOf(node.id)).toHaveLength(1));
    const threadId = db.chatThreadsOf(node.id)[0]!.id;
    await waitFor(() =>
      expect(screen.getByTestId(`chat-thread-${threadId}`)).toHaveAttribute('data-active', 'true'),
    );
    expect(screen.getByTestId(`chat-thread-${threadId}`)).toHaveTextContent('first conversation');
    // the theme's pills: the open thread has the ink border on the surface, like an active tab
    expect(screen.getByTestId(`chat-thread-${threadId}`).closest('li')?.className).toContain(
      'border-[var(--ink)]',
    );
    expect(screen.getByTestId('chat-new-thread')).toHaveTextContent('New chat');
    expect(screen.getByTestId(`chat-delete-${threadId}`)).toHaveAccessibleName(
      'Delete chat first conversation',
    );
  });

  it('New chat clears the active thread and empties the conversation', async () => {
    const user = userEvent.setup();
    const { workflowId, node } = seedAgentNode();
    renderChat(<ChatPanel workflowId={workflowId} />);

    await waitFor(() => expect(screen.getByTestId('chat-input')).toBeInTheDocument());
    await user.type(screen.getByTestId('chat-input'), 'hello there');
    await user.click(screen.getByTestId('chat-send'));
    await waitFor(() =>
      expect(screen.getByTestId('chat-conversation')).toHaveTextContent('You said: hello there'),
    );
    await waitFor(() => expect(db.chatThreadsOf(node.id)).toHaveLength(1));

    await user.click(screen.getByTestId('chat-new-thread'));
    await waitFor(() =>
      expect(screen.getByTestId('chat-conversation')).not.toHaveTextContent(
        'You said: hello there',
      ),
    );
    const threadId = db.chatThreadsOf(node.id)[0]!.id;
    expect(screen.getByTestId(`chat-thread-${threadId}`)).toHaveAttribute('data-active', 'false');
    expect(screen.getByTestId(`chat-thread-${threadId}`).closest('li')?.className).toContain(
      'border-[var(--line)]',
    );
  });

  it('deletes a thread', async () => {
    const user = userEvent.setup();
    const { workflowId, node } = seedAgentNode();
    renderChat(<ChatPanel workflowId={workflowId} />);

    await waitFor(() => expect(screen.getByTestId('chat-input')).toBeInTheDocument());
    await user.type(screen.getByTestId('chat-input'), 'to be deleted');
    await user.click(screen.getByTestId('chat-send'));
    await waitFor(() => expect(db.chatThreadsOf(node.id)).toHaveLength(1));
    const threadId = db.chatThreadsOf(node.id)[0]!.id;

    // [audit W-9] it asks first; Cancel keeps the thread
    await user.click(screen.getByTestId(`chat-delete-${threadId}`));
    const confirm = await screen.findByTestId('chat-delete-confirm');
    expect(confirm).toHaveTextContent('Delete this chat?');
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(db.chatThreadsOf(node.id)).toHaveLength(1);

    await user.click(screen.getByTestId(`chat-delete-${threadId}`));
    await user.click(
      within(await screen.findByTestId('chat-delete-confirm')).getByRole('button', {
        name: 'Delete chat',
      }),
    );
    await waitFor(() => expect(db.chatThreadsOf(node.id)).toHaveLength(0));
    await waitFor(() =>
      expect(screen.queryByTestId(`chat-thread-${threadId}`)).not.toBeInTheDocument(),
    );
  });
});
