import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { usePanelsStore } from '../app/stores/panels';
import { createNode } from '../nodes/factory';
import { ChatAside } from './ChatAside';
import { db, installChatMockServer, queryClient, renderChat, seedAgentNode } from './test-support';

installChatMockServer();

beforeEach(() => {
  usePanelsStore.getState().chatWith(undefined);
});

describe('FR-CHAT-004 the Chat column', () => {
  it('shows the intro with no target', async () => {
    const { workflowId, node } = seedAgentNode();
    renderChat(<ChatAside workflowId={workflowId} />);
    expect(screen.getByText('Mention any Agent or Model node to talk to it directly.')).toBeInTheDocument();
    expect(await screen.findByTestId(`chat-mention-${node.id}`)).toHaveTextContent('@Writer');
    expect(screen.queryByTestId('chat-conversation')).toBeNull();
  });

  it('a chip opens the conversation for that node', async () => {
    const user = userEvent.setup();
    const { workflowId, node } = seedAgentNode();
    renderChat(<ChatAside workflowId={workflowId} />);
    await user.click(await screen.findByTestId(`chat-mention-${node.id}`));
    expect(await screen.findByTestId('chat-conversation')).toBeInTheDocument();
    expect(usePanelsStore.getState().chatNodeId).toBe(node.id);
    expect(screen.getByTestId('chat-input')).toHaveAttribute('placeholder', 'Message @Writer');
    expect(screen.getByTestId(`chat-mention-${node.id}`).className).toContain('border-border-strong');
  });

  it('gives a Merge node no chip', async () => {
    const { workflowId, node } = seedAgentNode();
    const merge = createNode('merge', workflowId, { x: 10, y: 10 });
    db.commitGraph(workflowId, [node, merge], []);
    renderChat(<ChatAside workflowId={workflowId} />);
    await screen.findByTestId(`chat-mention-${node.id}`);
    expect(screen.queryByTestId(`chat-mention-${merge.id}`)).toBeNull();
  });

  it('returns to the intro and clears the target when the node is deleted', async () => {
    const { workflowId, node } = seedAgentNode();
    usePanelsStore.getState().chatWith(node.id);
    renderChat(<ChatAside workflowId={workflowId} />);
    expect(await screen.findByTestId('chat-conversation')).toBeInTheDocument();
    db.commitGraph(workflowId, [], []);
    await queryClient.invalidateQueries();
    await waitFor(() => expect(usePanelsStore.getState().chatNodeId).toBeUndefined());
    expect(screen.getByText(/Mention any Agent or Model/)).toBeInTheDocument();
  });

  it('resets when the target is not an Agent or Model', async () => {
    const { workflowId, node } = seedAgentNode();
    const output = createNode('output', workflowId, { x: 10, y: 10 });
    db.commitGraph(workflowId, [node, output], []);
    usePanelsStore.getState().chatWith(output.id);
    renderChat(<ChatAside workflowId={workflowId} />);
    expect(await screen.findByText(/Mention any Agent or Model node/)).toBeInTheDocument();
    expect(screen.queryByTestId('chat-conversation')).toBeNull();
  });

  it('typing @Dr opens a picker and Enter picks Draft', async () => {
    const user = userEvent.setup();
    const { workflowId, node } = seedAgentNode({ name: 'Draft' });
    renderChat(<ChatAside workflowId={workflowId} />);
    await screen.findByTestId(`chat-mention-${node.id}`);
    const input = screen.getByPlaceholderText('Message a node — type @ to pick one');
    await user.type(input, '@Dr');
    const picker = await screen.findByTestId('chat-mention-picker');
    expect(picker).toHaveTextContent('Draft');
    await user.keyboard('{Enter}');
    expect(usePanelsStore.getState().chatNodeId).toBe(node.id);
    expect(await screen.findByTestId('chat-conversation')).toBeInTheDocument();
  });
});
