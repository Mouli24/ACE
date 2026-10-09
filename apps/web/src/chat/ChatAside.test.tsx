import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { api } from '../app/api';
import { getSocket } from '../app/socket';
import { usePanelsStore } from '../app/stores/panels';
import { useSelectionStore } from '../app/stores/selection';
import { setChatScenario } from '../mocks/handlers-round4';
import { createNode } from '../nodes/factory';
import { ChatAside } from './ChatAside';
import { db, installChatMockServer, queryClient, renderChat, seedAgentNode } from './test-support';

installChatMockServer();

const conversation = () => screen.getByTestId('chat-conversation');

/** Type a message into the composer and send it with Enter. */
async function say(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.type(screen.getByTestId('chat-input'), text);
  await user.keyboard('{Enter}');
}

/** Two Agent nodes in one workflow, with nothing selected. */
function seedTwo() {
  const { workflowId, node: writer } = seedAgentNode({ name: 'Writer' });
  const { node: critic } = seedAgentNode({ name: 'Critic', workflowId });
  useSelectionStore.getState().clear();
  return { workflowId, writer, critic };
}

describe('FR-CHAT-004 the Chat column', () => {
  it('shows the intro with no target', async () => {
    const { workflowId, node } = seedAgentNode();
    useSelectionStore.getState().clear();
    renderChat(<ChatAside workflowId={workflowId} />);
    expect(await screen.findByTestId(`chat-mention-${node.id}`)).toHaveTextContent('@Writer');
    expect(screen.getByText(/Select an Agent node on the Canvas, or mention one/)).toBeInTheDocument();
    expect(screen.queryByTestId('chat-conversation')).toBeNull();
    // nobody to send to yet
    expect(screen.getByTestId('chat-send')).toBeDisabled();
  });

  it('D285: follows the node selected on the Canvas', async () => {
    const { workflowId, writer, critic } = seedTwo();
    renderChat(<ChatAside workflowId={workflowId} />);
    await screen.findByTestId(`chat-mention-${writer.id}`);

    useSelectionStore.getState().setSelection([critic.id], []);
    await waitFor(() => expect(conversation()).toHaveAttribute('data-node-id', critic.id));
    expect(screen.getByTestId('chat-target')).toHaveTextContent('Critic');

    useSelectionStore.getState().setSelection([writer.id], []);
    await waitFor(() => expect(conversation()).toHaveAttribute('data-node-id', writer.id));
  });

  it('a chip opens the conversation for that node', async () => {
    const user = userEvent.setup();
    const { workflowId, writer } = seedTwo();
    renderChat(<ChatAside workflowId={workflowId} />);
    await user.click(await screen.findByTestId(`chat-mention-${writer.id}`));
    expect(await screen.findByTestId('chat-conversation')).toBeInTheDocument();
    expect(usePanelsStore.getState().chatNodeId).toBe(writer.id);
    expect(screen.getByTestId('chat-input')).toHaveAttribute('placeholder', 'Message @Writer');
    expect(screen.getByTestId(`chat-mention-${writer.id}`).className).toContain('border-border-strong');
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
    useSelectionStore.getState().clear();
    usePanelsStore.getState().chatWith(node.id);
    renderChat(<ChatAside workflowId={workflowId} />);
    expect(await screen.findByTestId('chat-conversation')).toBeInTheDocument();
    db.commitGraph(workflowId, [], []);
    await queryClient.invalidateQueries();
    await waitFor(() => expect(usePanelsStore.getState().chatNodeId).toBeUndefined());
    expect(screen.getByText(/Select an Agent node on the Canvas/)).toBeInTheDocument();
  });

  it('resets when the target is not an Agent or Model', async () => {
    const { workflowId, node } = seedAgentNode();
    useSelectionStore.getState().clear();
    const output = createNode('output', workflowId, { x: 10, y: 10 });
    db.commitGraph(workflowId, [node, output], []);
    usePanelsStore.getState().chatWith(output.id);
    renderChat(<ChatAside workflowId={workflowId} />);
    expect(await screen.findByText(/Select an Agent node on the Canvas/)).toBeInTheDocument();
    expect(screen.queryByTestId('chat-conversation')).toBeNull();
  });
});

describe('FR-CHAT-004 @mentions', () => {
  it('typing @Dr opens a picker and Enter picks Draft', async () => {
    const user = userEvent.setup();
    const { workflowId, node } = seedAgentNode({ name: 'Draft' });
    useSelectionStore.getState().clear();
    renderChat(<ChatAside workflowId={workflowId} />);
    await screen.findByTestId(`chat-mention-${node.id}`);
    const input = screen.getByPlaceholderText('Message a node — type @ to pick one');
    await user.type(input, '@Dr');
    const picker = await screen.findByTestId('chat-mention-picker');
    expect(picker).toHaveTextContent('Draft');
    await user.keyboard('{Enter}');
    expect(usePanelsStore.getState().chatNodeId).toBe(node.id);
    expect(await screen.findByTestId('chat-conversation')).toBeInTheDocument();
    // the mention is completed in the box, ready for the message
    expect(screen.getByTestId('chat-input')).toHaveValue('@Draft ');
  });

  it('sends "@Name message" to that node — without the mention — from the intro', async () => {
    const user = userEvent.setup();
    const { workflowId, writer } = seedTwo();
    renderChat(<ChatAside workflowId={workflowId} />);
    await screen.findByTestId(`chat-mention-${writer.id}`);

    await user.type(screen.getByTestId('chat-input'), '@Writer write a haiku');
    await user.click(screen.getByTestId('chat-send'));

    await waitFor(() => expect(conversation()).toHaveAttribute('data-node-id', writer.id));
    await waitFor(() => expect(conversation()).toHaveTextContent('You said: write a haiku'));
    expect(conversation()).not.toHaveTextContent('@Writer write');
  });

  it('routes a mention to another node while one is open, and switches to it', async () => {
    const user = userEvent.setup();
    const { workflowId, writer, critic } = seedTwo();
    usePanelsStore.getState().chatWith(writer.id);
    renderChat(<ChatAside workflowId={workflowId} />);
    await screen.findByTestId('chat-conversation');

    await user.type(screen.getByTestId('chat-input'), '@Critic review it');
    await user.keyboard('{Escape}');
    await user.keyboard('{Enter}');

    await waitFor(() => expect(usePanelsStore.getState().chatNodeId).toBe(critic.id));
    await waitFor(() => expect(conversation()).toHaveTextContent('You said: review it'));
    // nothing reached the Writer
    expect(await api().listNodeChatThreads(writer.id)).toEqual([]);
  });
});

describe('D285 the chat and the Canvas agree on the node in focus', () => {
  it('after an @mention moves the chat, clicking the card that was selected brings its chat back', async () => {
    const user = userEvent.setup();
    const { workflowId, writer, critic } = seedTwo();
    renderChat(<ChatAside workflowId={workflowId} />);

    useSelectionStore.getState().setSelection([critic.id], []);
    await waitFor(() => expect(conversation()).toHaveAttribute('data-node-id', critic.id));

    await user.type(screen.getByTestId('chat-input'), '@Writer hi');
    await user.keyboard('{Escape}');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(conversation()).toHaveAttribute('data-node-id', writer.id));
    // the Canvas selection followed the chat
    expect(useSelectionStore.getState().focusedNodeId).toBe(writer.id);

    // what a click on the Critic's card does
    useSelectionStore.getState().setSelection([critic.id], []);
    await waitFor(() => expect(conversation()).toHaveAttribute('data-node-id', critic.id));
  });
});

describe('D285 each node keeps its own session', () => {
  it('keeps two nodes’ histories apart across switching', async () => {
    const user = userEvent.setup();
    const { workflowId, writer, critic } = seedTwo();
    renderChat(<ChatAside workflowId={workflowId} />);

    useSelectionStore.getState().setSelection([writer.id], []);
    await waitFor(() => expect(conversation()).toHaveAttribute('data-node-id', writer.id));
    await say(user, 'first to writer');
    await waitFor(() => expect(conversation()).toHaveTextContent('You said: first to writer'));

    useSelectionStore.getState().setSelection([critic.id], []);
    await waitFor(() => expect(conversation()).toHaveAttribute('data-node-id', critic.id));
    expect(conversation()).not.toHaveTextContent('first to writer');
    await say(user, 'first to critic');
    await waitFor(() => expect(conversation()).toHaveTextContent('You said: first to critic'));

    useSelectionStore.getState().setSelection([writer.id], []);
    await waitFor(() => expect(conversation()).toHaveTextContent('You said: first to writer'));
    expect(conversation()).not.toHaveTextContent('first to critic');
  });

  it('a reply that lands while another node is on screen is there on return', async () => {
    const user = userEvent.setup();
    const { workflowId, writer, critic } = seedTwo();
    renderChat(<ChatAside workflowId={workflowId} />);

    useSelectionStore.getState().setSelection([writer.id], []);
    await waitFor(() => expect(conversation()).toHaveAttribute('data-node-id', writer.id));
    await say(user, 'are you there');
    // the reply is owed: switch away before it lands
    await waitFor(() => expect(conversation()).toHaveTextContent('are you there'));
    useSelectionStore.getState().setSelection([critic.id], []);
    await waitFor(() => expect(conversation()).toHaveAttribute('data-node-id', critic.id));

    await waitFor(async () => {
      const [thread] = await api().listNodeChatThreads(writer.id);
      const detail = await api().getChatThread(thread!.id);
      expect(detail.messages.map((m) => m.role)).toEqual(['user', 'agent']);
    });
    useSelectionStore.getState().setSelection([writer.id], []);
    await waitFor(() => expect(conversation()).toHaveTextContent('You said: are you there'));
    expect(screen.queryByTestId('chat-thinking')).toBeNull();
  });

  it('says why a message was not sent, on the node it was sent to only', async () => {
    const user = userEvent.setup();
    const { workflowId, node: unset } = seedAgentNode({ name: 'Unset', withModel: false });
    const { node: other } = seedAgentNode({ name: 'Other', workflowId });
    useSelectionStore.getState().clear();
    renderChat(<ChatAside workflowId={workflowId} />);

    useSelectionStore.getState().setSelection([unset.id], []);
    await waitFor(() => expect(conversation()).toHaveAttribute('data-node-id', unset.id));
    await say(user, 'hello');
    const alert = await screen.findByTestId('chat-send-error');
    expect(alert).toHaveTextContent('"Unset" has no provider and model chosen yet.');

    useSelectionStore.getState().setSelection([other.id], []);
    await waitFor(() => expect(conversation()).toHaveAttribute('data-node-id', other.id));
    expect(screen.queryByTestId('chat-send-error')).toBeNull();

    useSelectionStore.getState().setSelection([unset.id], []);
    expect(await screen.findByTestId('chat-send-error')).toBeInTheDocument();
  });

  it('shows a reply that failed as an error turn, never a stuck stream', async () => {
    setChatScenario('chat-fails');
    const user = userEvent.setup();
    const { workflowId, node } = seedAgentNode();
    renderChat(<ChatAside workflowId={workflowId} />);
    await waitFor(() => expect(conversation()).toHaveAttribute('data-node-id', node.id));

    await say(user, 'hello');
    const turn = await screen.findByTestId('chat-error-turn');
    expect(turn).toHaveAttribute('data-code', 'cli_not_signed_in');
    expect(turn).toHaveTextContent('not signed in');
    await waitFor(() => expect(screen.queryByTestId('chat-streaming')).toBeNull());
    expect(screen.queryByTestId('chat-thinking')).toBeNull();
  });

  it('puts a run’s goal and result in the node’s chat, never on the Canvas', async () => {
    const { workflowId, node } = seedAgentNode({
      instructions: 'Write a haiku about rain.',
      inputTypes: ['text'],
    });
    renderChat(<ChatAside workflowId={workflowId} />);
    await waitFor(() => expect(conversation()).toHaveAttribute('data-node-id', node.id));
    getSocket()?.subscribe({ scope: 'workflow', id: workflowId });

    const run = await api().startRun(workflowId, {});
    expect(run.status).toBe('RUNNING');

    const badges = await screen.findAllByTestId('chat-run-badge', {}, { timeout: 5000 });
    expect(badges.length).toBeGreaterThan(0);
    const turns = within(conversation());
    expect(turns.getAllByTestId('chat-turn-user')[0]).toHaveTextContent('Write a haiku about rain.');
    expect(turns.getAllByTestId('chat-turn-agent').length).toBeGreaterThan(0);
  });
});
