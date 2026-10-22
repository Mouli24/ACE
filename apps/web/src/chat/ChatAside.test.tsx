import type { ChatMessage } from '@ace/contracts';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { api } from '../app/api';
import { getSocket } from '../app/socket';
import { useLayoutStore } from '../app/stores/layout';
import { usePanelsStore } from '../app/stores/panels';
import { useSelectionStore } from '../app/stores/selection';
import { useWorkspaceStatus } from '../app/stores/workspace-status';
import { newId } from '../lib/ulid';
import { setChatScenario } from '../mocks/handlers-round4';
import { createNode } from '../nodes/factory';
import { ChatAside } from './ChatAside';
import { useComposerChips } from './composer-chips';
import { oweTurn, useChatSessions } from './session-store';
import {
  checkpoints,
  db,
  installChatMockServer,
  queryClient,
  renderChat,
  seedAgentNode,
} from './test-support';

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
    // the theme's tab: avatar initial, the node's name and its handle
    const tab = await screen.findByTestId(`chat-mention-${node.id}`);
    expect(tab).toHaveTextContent('Writer');
    expect(tab).toHaveTextContent('@writer');
    expect(tab).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('heading', { name: 'Team chat' })).toBeInTheDocument();
    expect(
      screen.getByText(/Select an Agent node on the Canvas, or pick one above/),
    ).toBeInTheDocument();
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
    expect(screen.getByTestId(`chat-mention-${critic.id}`)).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId(`chat-mention-${writer.id}`)).toHaveAttribute(
      'aria-pressed',
      'false',
    );

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
    // the active tab: ink border on the surface (D335)
    const tab = screen.getByTestId(`chat-mention-${writer.id}`);
    expect(tab).toHaveAttribute('aria-pressed', 'true');
    expect(tab.className).toContain('border-[var(--ink)]');
    expect(tab.className).toContain('bg-[var(--surface)]');
    expect(screen.getByTestId('chat-input')).toHaveAttribute(
      'placeholder',
      'Message the team… @ to tag an agent, / for commands',
    );
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
    // [audit W-15] said once by the announcement; the turn itself is no alert to re-read on load
    expect(turn).not.toHaveAttribute('role', 'alert');
    expect(screen.getByTestId('chat-announce')).toHaveTextContent('could not answer.');
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
    expect(turns.getAllByTestId('chat-turn-user')[0]).toHaveTextContent(
      'Write a haiku about rain.',
    );
    expect(turns.getAllByTestId('chat-turn-agent').length).toBeGreaterThan(0);
  });
});

describe('D335 the theme’s Team chat header', () => {
  it('shows Live only while the socket is open', async () => {
    const { workflowId } = seedAgentNode();
    renderChat(<ChatAside workflowId={workflowId} />);
    await waitFor(() => expect(getSocket()?.status).toBe('open'));
    expect(await screen.findByTestId('chat-live')).toHaveTextContent('Live');

    act(() => getSocket()?.close());
    await waitFor(() => expect(screen.queryByTestId('chat-live')).toBeNull());
  });

  it('✕ closes the chat column', async () => {
    const user = userEvent.setup();
    const { workflowId } = seedAgentNode();
    renderChat(<ChatAside workflowId={workflowId} />);
    expect(useLayoutStore.getState().chatOpen).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Close chat' }));
    expect(useLayoutStore.getState().chatOpen).toBe(false);
  });

  it('has no Pin, Voice, "Actions +" or team-run hint (no such features)', async () => {
    const { workflowId, node } = seedAgentNode();
    renderChat(<ChatAside workflowId={workflowId} />);
    await screen.findByTestId(`chat-mention-${node.id}`);
    const aside = screen.getByTestId('chat-aside');
    expect(within(aside).queryByTitle('Pin')).toBeNull();
    expect(within(aside).queryByTitle('Voice')).toBeNull();
    expect(within(aside).queryByText(/^Actions/)).toBeNull();
    expect(within(aside).queryByText('Enter starts a team run')).toBeNull();
    // the two composer buttons that stay
    expect(within(aside).getByRole('button', { name: 'Attach a file' })).toBeInTheDocument();
    expect(within(aside).getByRole('button', { name: 'Send message' })).toBeInTheDocument();
  });
});

describe('D335 the tabs: one per agent or model node, the rest under More', () => {
  function seedFive() {
    const { workflowId, node: first } = seedAgentNode({ name: 'Alpha' });
    const rest = ['Bravo', 'Charlie', 'Delta', 'Echo'].map(
      (name) => seedAgentNode({ name, workflowId }).node,
    );
    useSelectionStore.getState().clear();
    return { workflowId, nodes: [first, ...rest] };
  }

  it('draws the first three as tabs and counts the rest on More', async () => {
    const { workflowId, nodes } = seedFive();
    renderChat(<ChatAside workflowId={workflowId} />);
    await screen.findByTestId(`chat-mention-${nodes[0]!.id}`);
    expect(screen.getByTestId(`chat-mention-${nodes[1]!.id}`)).toBeInTheDocument();
    expect(screen.getByTestId(`chat-mention-${nodes[2]!.id}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`chat-mention-${nodes[3]!.id}`)).toBeNull();
    expect(screen.queryByTestId(`chat-mention-${nodes[4]!.id}`)).toBeNull();
    const more = screen.getByTestId('chat-mention-more');
    expect(more).toHaveTextContent('More');
    expect(more).toHaveTextContent('2');
    // no Team chat tab: the aside has no team-level chat
    expect(within(screen.getByTestId('chat-mentions')).queryByText('Team chat')).toBeNull();
  });

  it('More opens a menu with the rest; picking one opens its session', async () => {
    const user = userEvent.setup();
    const { workflowId, nodes } = seedFive();
    renderChat(<ChatAside workflowId={workflowId} />);
    await user.click(await screen.findByTestId('chat-mention-more'));

    const menu = await screen.findByTestId('chat-mention-more-menu');
    expect(within(menu).getByTestId(`chat-mention-${nodes[3]!.id}`)).toHaveTextContent('Delta');
    expect(within(menu).getByTestId(`chat-mention-${nodes[4]!.id}`)).toHaveTextContent('@echo');
    await user.click(within(menu).getByTestId(`chat-mention-${nodes[4]!.id}`));

    expect(usePanelsStore.getState().chatNodeId).toBe(nodes[4]!.id);
    expect(useSelectionStore.getState().focusedNodeId).toBe(nodes[4]!.id);
    await waitFor(() => expect(conversation()).toHaveAttribute('data-node-id', nodes[4]!.id));
    // the node in focus is under More, so More reads as the active tab
    expect(screen.getByTestId('chat-mention-more').className).toContain('border-[var(--ink)]');
  });
});

const THREAD = '01THREAD000000000000000000';
const userTurn = (text: string): ChatMessage => ({
  id: '01USERTURN0000000000000000',
  threadId: THREAD,
  role: 'user',
  content: [{ type: 'text', text }],
  verdicts: [],
  at: new Date().toISOString(),
});

/** The engine took a message for this node: its reply is owed on `THREAD`. */
const owe = (nodeId: string, text: string) =>
  act(() =>
    useChatSessions.getState().update(nodeId, (session) => ({
      ...session,
      threadId: THREAD,
      pending: { threadId: THREAD, userMessage: userTurn(text) },
    })),
  );

describe('D335 the theme’s message rows', () => {
  it('names each turn, and a reply that wrote no files has no Forge button', async () => {
    const user = userEvent.setup();
    const { workflowId } = seedAgentNode();
    renderChat(<ChatAside workflowId={workflowId} />);
    await waitFor(() => expect(conversation()).toBeInTheDocument());

    await say(user, 'hello');
    await waitFor(() =>
      expect(screen.getByTestId('chat-turn-agent')).toHaveTextContent('You said: hello'),
    );
    const agentTurn = screen.getByTestId('chat-turn-agent');
    const userTurnRow = screen.getByTestId('chat-turn-user');
    expect(userTurnRow).toHaveTextContent(/^YYou/);
    expect(agentTurn).toHaveTextContent(/^✳Writer/);
    // the real usage the engine recorded, in the theme's short form
    expect(within(agentTurn).getByTestId('chat-usage')).toHaveTextContent(/^8 in · \d+ out$/);
    // agents write into the project themselves: nothing is sent to Forge, and a turn that wrote
    // nothing has nothing to open there
    expect(within(agentTurn).queryByRole('button', { name: /Send to Forge/ })).toBeNull();
    expect(within(agentTurn).queryByTestId('chat-open-in-forge')).toBeNull();
  });

  it('draws a Markdown list as the theme’s bullet rows', async () => {
    const { workflowId, node } = seedAgentNode();
    renderChat(<ChatAside workflowId={workflowId} />);
    await waitFor(() => expect(conversation()).toHaveAttribute('data-node-id', node.id));
    owe(node.id, 'list it');
    act(() => useChatSessions.getState().appendToken(THREAD, 'Plan:\n\n- one\n- two'));

    const items = within(await screen.findByTestId('chat-streaming')).getAllByRole('listitem');
    // the theme's orange bullet before each item…
    expect(items.map((item) => item.textContent)).toEqual(['•one', '•two']);
    expect(within(items[0]!).getByText('•').className).toContain('text-[#ef6b3f]');
    // …in the aside's 12.5px / 1.4 list type, under 13px / 1.5 text
    const markdown = items[0]!.closest('[data-testid="markdown"]');
    expect(markdown?.className).toContain('[&_ul>li]:text-[12.5px]');
    expect(markdown?.className).toContain('[&_ul>li]:leading-[1.4]');
    expect(markdown?.className).toContain('text-[13px]');
    expect(markdown?.className).toContain('leading-[1.5]');
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
  });
});

describe('D335 "{name} is typing…" follows the real stream only', () => {
  it('shows while a reply is owed, stays under the streamed text, and goes when it settles', async () => {
    const { workflowId, node } = seedAgentNode();
    renderChat(<ChatAside workflowId={workflowId} />);
    await waitFor(() => expect(conversation()).toHaveAttribute('data-node-id', node.id));
    expect(screen.queryByText(/is typing…/)).toBeNull();

    // the engine took the message; no token yet
    owe(node.id, 'hi');
    expect(await screen.findByTestId('chat-thinking')).toHaveTextContent('Writer is typing…');
    expect(screen.queryByTestId('chat-streaming')).toBeNull();

    // the first token: the growing reply has its own row, typing goes on under it
    act(() => useChatSessions.getState().appendToken(THREAD, 'Hel'));
    expect(screen.getByTestId('chat-streaming')).toHaveTextContent('Hel');
    expect(screen.queryByTestId('chat-thinking')).toBeNull();
    expect(screen.getByTestId('chat-typing')).toHaveTextContent('Writer is typing…');

    act(() => useChatSessions.getState().settleThread(THREAD));
    expect(screen.queryByTestId('chat-streaming')).toBeNull();
    expect(screen.queryByText(/is typing…/)).toBeNull();
  });
});

describe('D391 each sent message waits for its own reply', () => {
  /** The engine took one more message for this node, behind any it still owes a reply. */
  const oweNext = (nodeId: string, text: string) =>
    useChatSessions
      .getState()
      .update(nodeId, (session) =>
        oweTurn(
          { ...session, threadId: THREAD },
          { threadId: THREAD, userMessage: { ...userTurn(text), id: newId() }, since: Date.now() },
        ),
      );

  it('says "N queued" while more than one turn is outstanding, and keeps Stop until the last reply', async () => {
    const { workflowId, node } = seedAgentNode();
    renderChat(<ChatAside workflowId={workflowId} />);
    await waitFor(() => expect(conversation()).toHaveAttribute('data-node-id', node.id));
    expect(screen.queryByTestId('chat-queued')).toBeNull();

    // two messages back to back: the engine answers the first while the second waits its turn
    act(() => {
      oweNext(node.id, 'first');
      oweNext(node.id, 'second');
    });
    expect(await screen.findByTestId('chat-queued')).toHaveTextContent('1 queued');
    expect(screen.getByTestId('chat-stop')).toBeInTheDocument();
    expect(screen.getByTestId('chat-thinking')).toHaveTextContent('Writer is typing…');

    // the first reply settles the first message only: the second still waits, Stop stays
    act(() => useChatSessions.getState().settleReply(THREAD, newId()));
    expect(screen.queryByTestId('chat-queued')).toBeNull();
    expect(screen.getByTestId('chat-stop')).toBeInTheDocument();
    expect(screen.getByTestId('chat-thinking')).toHaveTextContent('Writer is typing…');

    // the second reply: nothing is owed any more
    act(() => useChatSessions.getState().settleReply(THREAD, newId()));
    expect(screen.queryByTestId('chat-stop')).toBeNull();
    expect(screen.queryByText(/is typing…/)).toBeNull();
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
  });
});

describe('D330 the footer’s message count', () => {
  it('publishes the open session’s count, and null with no target or once the column goes', async () => {
    const user = userEvent.setup();
    const { workflowId, writer, critic } = seedTwo();
    const view = renderChat(<ChatAside workflowId={workflowId} />);
    await screen.findByTestId(`chat-mention-${writer.id}`);
    expect(useWorkspaceStatus.getState().messageCount).toBeNull();

    useSelectionStore.getState().setSelection([writer.id], []);
    await waitFor(() => expect(conversation()).toHaveAttribute('data-node-id', writer.id));
    await waitFor(() => expect(useWorkspaceStatus.getState().messageCount).toBe(0));
    await say(user, 'count me');
    await waitFor(() => expect(conversation()).toHaveTextContent('You said: count me'));
    await waitFor(() => expect(useWorkspaceStatus.getState().messageCount).toBe(2));

    // another node's session has its own count
    useSelectionStore.getState().setSelection([critic.id], []);
    await waitFor(() => expect(conversation()).toHaveAttribute('data-node-id', critic.id));
    await waitFor(() => expect(useWorkspaceStatus.getState().messageCount).toBe(0));

    // no target: nothing to count
    act(() => {
      useSelectionStore.getState().clear();
      usePanelsStore.getState().chatWith(undefined);
    });
    await waitFor(() => expect(useWorkspaceStatus.getState().messageCount).toBeNull());

    useSelectionStore.getState().setSelection([writer.id], []);
    await waitFor(() => expect(useWorkspaceStatus.getState().messageCount).toBe(2));
    view.unmount();
    expect(useWorkspaceStatus.getState().messageCount).toBeNull();
  });
});

describe('D302 @handle brings another node into the conversation', () => {
  it('typing @cr opens a picker; Enter completes @critic and the chat stays where it was', async () => {
    const user = userEvent.setup();
    const { workflowId, writer, critic } = seedTwo();
    usePanelsStore.getState().chatWith(writer.id);
    renderChat(<ChatAside workflowId={workflowId} />);
    await screen.findByTestId('chat-conversation');

    await user.type(screen.getByTestId('chat-input'), 'ask @cr');
    const picker = await screen.findByTestId('chat-mention-picker');
    expect(picker).toHaveTextContent('Critic');
    expect(picker).toHaveTextContent('@critic');
    expect(within(picker).getByTestId(`chat-mention-option-${critic.id}`)).toBeInTheDocument();
    await user.keyboard('{Enter}');

    expect(screen.getByTestId('chat-input')).toHaveValue('ask @critic ');
    expect(screen.queryByTestId('chat-mention-picker')).toBeNull();
    // no session switch: the Writer is still the conversation's main node
    expect(usePanelsStore.getState().chatNodeId).toBe(writer.id);
    expect(conversation()).toHaveAttribute('data-node-id', writer.id);
  });

  it('says who it goes to, sends it with targetNodeId in the same thread, and names the speaker', async () => {
    const user = userEvent.setup();
    const { workflowId, writer, critic } = seedTwo();
    usePanelsStore.getState().chatWith(writer.id);
    renderChat(<ChatAside workflowId={workflowId} />);
    await screen.findByTestId('chat-conversation');

    await user.type(screen.getByTestId('chat-input'), '@critic review it');
    expect(screen.getByTestId('chat-send-preview')).toHaveTextContent('to Critic');
    await user.keyboard('{Enter}');

    const reply = await screen.findByTestId('chat-turn-agent', {}, { timeout: 3000 });
    await waitFor(() => expect(reply).toHaveTextContent('You said: @critic review it'));
    // the speaker is the Critic, by name and avatar, in the Writer's conversation
    expect(within(reply).getByTestId('chat-speaker')).toHaveTextContent('Critic');
    expect(reply).toHaveTextContent(/^CCritic/);
    expect(usePanelsStore.getState().chatNodeId).toBe(writer.id);
    expect(conversation()).toHaveAttribute('data-node-id', writer.id);
    // one thread, the Writer's; the mention stays in what was said
    const [thread] = await api().listNodeChatThreads(writer.id);
    const detail = await api().getChatThread(thread!.id);
    expect(detail.messages.map((m) => m.role)).toEqual(['user', 'agent']);
    expect(detail.messages[1]?.speakerNodeId).toBe(critic.id);
    expect(await api().listNodeChatThreads(critic.id)).toEqual([]);
  });

  it('a plain message previews the main node', async () => {
    const user = userEvent.setup();
    const { workflowId, writer } = seedTwo();
    usePanelsStore.getState().chatWith(writer.id);
    renderChat(<ChatAside workflowId={workflowId} />);
    await screen.findByTestId('chat-conversation');
    await user.type(screen.getByTestId('chat-input'), 'hello');
    expect(screen.getByTestId('chat-send-preview')).toHaveTextContent('to Writer');
  });

  it('an unknown handle disables Send and says why', async () => {
    const user = userEvent.setup();
    const { workflowId, writer } = seedTwo();
    usePanelsStore.getState().chatWith(writer.id);
    renderChat(<ChatAside workflowId={workflowId} />);
    await screen.findByTestId('chat-conversation');

    await user.type(screen.getByTestId('chat-input'), '@nobody hi');
    expect(screen.getByTestId('chat-target-error')).toHaveTextContent('no node is @nobody');
    expect(screen.getByTestId('chat-send')).toBeDisabled();
    await user.keyboard('{Enter}');
    expect(await api().listNodeChatThreads(writer.id)).toEqual([]);
  });
});

describe('D302 what an agent did, under its reply', () => {
  it('shows the activity collapsed as counts, and expands to the items', async () => {
    const user = userEvent.setup();
    const { workflowId, node } = seedAgentNode();
    const at = new Date().toISOString();
    db.addChatThread({ id: THREAD, nodeId: node.id, title: 'fix', createdAt: at, updatedAt: at });
    db.addChatMessage({ ...userTurn('fix the bug'), id: '01J0PERS0N0000000000000000' });
    db.addChatMessage({
      id: '01J0AGENT00000000000000000',
      threadId: THREAD,
      role: 'agent',
      content: [{ type: 'text', text: 'Fixed.' }],
      verdicts: [],
      at,
      speakerNodeId: node.id,
      activity: [
        { kind: 'read', tool: 'read_file', path: 'src/a.ts', summary: 'Read src/a.ts' },
        { kind: 'edit', tool: 'edit_file', path: 'src/a.ts', summary: 'Edited src/a.ts' },
        { kind: 'edit', tool: 'edit_file', path: 'src/b.ts', summary: 'Edited src/b.ts' },
      ],
    });
    renderChat(<ChatAside workflowId={workflowId} />);

    const toggle = await screen.findByRole('button', { name: /What it did: 2 edits, 1 read/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Edited src/b.ts')).toBeNull();
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const items = within(screen.getByTestId('chat-activity-list')).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining('Read src/a.ts'),
      expect.stringContaining('Edited src/a.ts'),
      expect.stringContaining('Edited src/b.ts'),
    ]);
    // a reply its own node gave keeps the node's mark, not a second avatar
    expect(screen.getByTestId('chat-turn-agent')).toHaveTextContent(/^✳Writer/);
  });

  it('renders Track A’s Changes card under a turn with a checkpoint, and none without', async () => {
    const { workflowId, node } = seedAgentNode();
    const projectId = db.getWorkflow(workflowId)?.projectId ?? '';
    const checkpoint = checkpoints.seed(projectId, [
      { path: 'src/a.ts', before: 'one\n', after: 'one\ntwo\n' },
      { path: 'gone.ts', before: 'x\n' },
    ]);
    const at = new Date().toISOString();
    db.addChatThread({ id: THREAD, nodeId: node.id, title: 'fix', createdAt: at, updatedAt: at });
    db.addChatMessage({
      id: '01J0AGENT00000000000000000',
      threadId: THREAD,
      role: 'agent',
      content: [{ type: 'text', text: 'Changed two files.' }],
      verdicts: [],
      at,
      checkpointId: checkpoint.id,
    });
    db.addChatMessage({
      id: '01J0AGENT00000000000000001',
      threadId: THREAD,
      role: 'agent',
      content: [{ type: 'text', text: 'Nothing to change.' }],
      verdicts: [],
      at,
    });
    renderChat(<ChatAside workflowId={workflowId} />);
    await waitFor(() => expect(conversation()).toHaveTextContent('Nothing to change.'));
    const card = await within(conversation()).findByRole('region', { name: 'Changes' });
    expect(card).toHaveAttribute('data-testid', `changes-card-${checkpoint.id}`);
    await waitFor(() => expect(card).toHaveTextContent('2 files'));
    for (const name of ['Review', 'Keep all', 'Revert all']) {
      expect(within(card).getByRole('button', { name })).toBeInTheDocument();
    }
    expect(within(conversation()).getAllByRole('region', { name: 'Changes' })).toHaveLength(1);
  });
});

describe('D302 Ask agent chips in the composer', () => {
  beforeEach(() => useComposerChips.getState().reset());

  it('shows each chip and sends it as a code part with its path and lines', async () => {
    const user = userEvent.setup();
    const { workflowId, node } = seedAgentNode();
    renderChat(<ChatAside workflowId={workflowId} />);
    await waitFor(() => expect(conversation()).toHaveAttribute('data-node-id', node.id));

    act(() =>
      useComposerChips.getState().add({
        path: 'src/a.ts',
        startLine: 3,
        endLine: 4,
        text: 'const a = 1;\nconst b = 2;',
        language: 'typescript',
      }),
    );
    expect(screen.getByTestId('chat-chips')).toHaveTextContent('src/a.ts:L3-L4');
    await waitFor(() => expect(screen.getByTestId('chat-input')).toHaveFocus());

    await say(user, 'why does this fail?');
    await waitFor(async () => {
      const [thread] = await api().listNodeChatThreads(node.id);
      const detail = await api().getChatThread(thread!.id);
      expect(detail.messages[0]?.content).toEqual([
        { type: 'text', text: 'why does this fail?' },
        {
          type: 'code',
          language: 'typescript',
          text: 'const a = 1;\nconst b = 2;',
          path: 'src/a.ts',
          startLine: 3,
          endLine: 4,
        },
      ]);
    });
    expect(screen.queryByTestId('chat-chips')).toBeNull();
    expect(useComposerChips.getState().chips).toEqual([]);
  });

  it('removes a chip with its ✕, and a draft fills the box once', async () => {
    const user = userEvent.setup();
    const { workflowId, node } = seedAgentNode();
    renderChat(<ChatAside workflowId={workflowId} />);
    await waitFor(() => expect(conversation()).toHaveAttribute('data-node-id', node.id));

    act(() => {
      useComposerChips.getState().add({ path: 'README.md', language: 'markdown' });
      useComposerChips.getState().prefill('Fix this problem: x');
    });
    await waitFor(() =>
      expect(screen.getByTestId('chat-input')).toHaveValue('Fix this problem: x'),
    );
    await user.click(screen.getByRole('button', { name: 'Remove README.md' }));
    expect(screen.queryByTestId('chat-chips')).toBeNull();
  });
});
