import type { ChatMessage } from '@ace/contracts';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';

import { setChatScenario } from '../mocks/handlers-round4';
import { ChatAside } from './ChatAside';
import { splitFences, useStalled } from './ChatConversation';
import { copyText } from './MessageActions';
import { useChatSessions } from './session-store';
import { db, installChatMockServer, renderChat, seedAgentNode } from './test-support';

/** The mock streams in real time; a loaded machine needs longer than waitFor's default second. */
const SLOW = { timeout: 5_000 };

installChatMockServer();

const conversation = () => screen.getByTestId('chat-conversation');

async function say(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.type(screen.getByTestId('chat-input'), text);
  await user.keyboard('{Enter}');
}

/** A chat with one answered turn: "You said: <text>". */
async function answered(text: string) {
  const user = userEvent.setup();
  const { workflowId, node } = seedAgentNode();
  renderChat(<ChatAside workflowId={workflowId} />);
  await waitFor(() => expect(conversation()).toHaveAttribute('data-node-id', node.id), SLOW);
  await say(user, text);
  await waitFor(
    () => expect(screen.getByTestId('chat-turn-agent')).toHaveTextContent(`You said: ${text}`),
    SLOW,
  );
  await waitFor(() => expect(screen.queryByTestId('chat-thinking')).toBeNull(), SLOW);
  return { user, node };
}

const storedOf = (nodeId: string): ChatMessage[] => {
  const thread = db.chatThreadsOf(nodeId)[0];
  return thread === undefined ? [] : db.chatMessagesOf(thread.id);
};

describe('PG-1.6 message actions in the chat (D352)', () => {
  it('Copy puts the message text on the clipboard', async () => {
    const { user } = await answered('copy me');
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    const agent = screen.getByTestId('chat-turn-agent');
    await user.click(within(agent).getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith('You said: copy me');
    expect(await within(agent).findByRole('button', { name: 'Copied' }, SLOW)).toBeInTheDocument();
  });

  it('a user message offers Copy, Edit & resend and Delete; an agent reply Copy, Retry and Delete', async () => {
    await answered('hello');
    const user = within(screen.getByTestId('chat-turn-user'));
    expect(user.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
    expect(user.getByRole('button', { name: 'Edit & resend' })).toBeInTheDocument();
    expect(user.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
    expect(user.queryByRole('button', { name: 'Retry' })).toBeNull();
    const agent = within(screen.getByTestId('chat-turn-agent'));
    expect(agent.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(agent.queryByRole('button', { name: 'Edit & resend' })).toBeNull();
  });

  it('Retry appends a new reply and folds the old one into "Earlier version"', async () => {
    const { user, node } = await answered('again');
    await user.click(
      within(screen.getByTestId('chat-turn-agent')).getByRole('button', { name: 'Retry' }),
    );
    await waitFor(
      () => expect(screen.getByTestId('chat-earlier-version')).toBeInTheDocument(),
      SLOW,
    );
    await waitFor(
      () => expect(storedOf(node.id).filter((message) => message.role === 'agent')).toHaveLength(2),
      SLOW,
    );
    // the new reply stands; the old one is folded away until opened
    await waitFor(() => expect(screen.getAllByTestId('chat-turn-agent')).toHaveLength(1), SLOW);
    const earlier = screen.getByRole('button', { name: /Earlier version/ });
    expect(earlier).toHaveAttribute('aria-expanded', 'false');
    await user.click(earlier);
    expect(screen.getAllByTestId('chat-turn-agent')).toHaveLength(2);
  });

  it('Retry on a failed turn runs it again', async () => {
    setChatScenario('chat-fails');
    const user = userEvent.setup();
    const { workflowId, node } = seedAgentNode();
    renderChat(<ChatAside workflowId={workflowId} />);
    await waitFor(() => expect(conversation()).toHaveAttribute('data-node-id', node.id), SLOW);
    await say(user, 'hello');
    await screen.findByTestId('chat-error-turn', undefined, SLOW);

    setChatScenario('chat-stream');
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(
      () => expect(screen.getByTestId('chat-turn-agent')).toHaveTextContent('You said: hello'),
      SLOW,
    );
    expect(screen.queryByTestId('chat-error-turn')).toBeNull();
  });

  it('Edit & resend sends the edited text as a new turn, and replaces what followed', async () => {
    const { user, node } = await answered('first wording');
    await user.click(
      within(screen.getByTestId('chat-turn-user')).getByRole('button', { name: 'Edit & resend' }),
    );
    const box = screen.getByRole('textbox', { name: 'Edit message' });
    expect(box).toHaveValue('first wording');
    await user.clear(box);
    await user.type(box, 'second wording{Enter}');

    await waitFor(
      () =>
        expect(screen.getByTestId('chat-turn-agent')).toHaveTextContent('You said: second wording'),
      SLOW,
    );
    expect(screen.getByTestId('chat-turn-user')).toHaveTextContent('second wording');
    expect(screen.getByText('Earlier version')).toBeInTheDocument();
    const stored = storedOf(node.id);
    expect(stored.filter((message) => message.supersededAt !== undefined)).toHaveLength(2);
  });

  it('Escape leaves the edit without sending anything', async () => {
    const { user, node } = await answered('keep me');
    await user.click(
      within(screen.getByTestId('chat-turn-user')).getByRole('button', { name: 'Edit & resend' }),
    );
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('textbox', { name: 'Edit message' })).toBeNull();
    expect(storedOf(node.id)).toHaveLength(2);
  });

  it('Delete hides a message', async () => {
    const { user, node } = await answered('forget this');
    await user.click(
      within(screen.getByTestId('chat-turn-user')).getByRole('button', { name: 'Delete' }),
    );
    await waitFor(() => expect(screen.queryByTestId('chat-turn-user')).toBeNull(), SLOW);
    expect(conversation()).not.toHaveTextContent(/^forget this/);
    expect(storedOf(node.id).find((message) => message.role === 'user')?.deletedAt).toBeDefined();
  });

  it('the composer offers Stop while a reply is on its way, and Stop ends it as cancelled', async () => {
    setChatScenario('chat-slow');
    const user = userEvent.setup();
    const { workflowId, node } = seedAgentNode();
    renderChat(<ChatAside workflowId={workflowId} />);
    await waitFor(() => expect(conversation()).toHaveAttribute('data-node-id', node.id), SLOW);
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();

    await say(user, 'take your time please');
    await user.click(await screen.findByRole('button', { name: 'Stop' }, SLOW));
    const stopped = await screen.findByTestId('chat-error-turn', undefined, SLOW);
    expect(stopped).toHaveAttribute('data-kind', 'user_cancelled');
    expect(stopped).toHaveTextContent('Stopped');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull(), SLOW);
  });
});

describe('PG-1.5 the stall rule: "No answer — Retry"', () => {
  function Probe({ since, budget }: { since: number | undefined; budget: number }) {
    return <output data-testid="stalled">{String(useStalled(since, budget))}</output>;
  }

  afterEach(() => vi.useRealTimers());

  it('turns true once nothing arrived for the timeout plus 10 s, and resets on a new token', () => {
    vi.useFakeTimers();
    const start = Date.now();
    const { rerender } = render(<Probe since={start} budget={1_000} />);
    act(() => vi.advanceTimersByTime(10_999));
    expect(screen.getByTestId('stalled')).toHaveTextContent('false');
    act(() => vi.advanceTimersByTime(2));
    expect(screen.getByTestId('stalled')).toHaveTextContent('true');

    // a token restarts the clock
    rerender(<Probe since={Date.now()} budget={1_000} />);
    expect(screen.getByTestId('stalled')).toHaveTextContent('false');
    // nothing owed, or a node with no timeout, never stalls
    rerender(<Probe since={undefined} budget={1_000} />);
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByTestId('stalled')).toHaveTextContent('false');
    rerender(<Probe since={Date.now()} budget={0} />);
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByTestId('stalled')).toHaveTextContent('false');
  });

  it('a stalled turn shows "No answer" with Retry, and Retry shows an answer that did land', async () => {
    const user = userEvent.setup();
    const { workflowId, node } = seedAgentNode();
    renderChat(<ChatAside workflowId={workflowId} />);
    await waitFor(() => expect(conversation()).toHaveAttribute('data-node-id', node.id), SLOW);
    await say(user, 'are you there');
    await waitFor(
      () =>
        expect(screen.getByTestId('chat-turn-agent')).toHaveTextContent('You said: are you there'),
      SLOW,
    );

    // The reply's frame was lost: the session still owes a reply, long past the node's timeout.
    const thread = db.chatThreadsOf(node.id)[0]!;
    const question = db.chatMessagesOf(thread.id).find((message) => message.role === 'user')!;
    act(() =>
      useChatSessions.getState().update(node.id, (session) => ({
        ...session,
        pending: {
          threadId: thread.id,
          userMessage: question,
          afterId: db.chatMessagesOf(thread.id).at(-1)!.id,
          since: Date.now() - 10 * 60_000,
        },
      })),
    );
    const stalled = await screen.findByTestId('chat-stalled', undefined, SLOW);
    expect(stalled).toHaveTextContent('No answer');
    await user.click(within(stalled).getByRole('button', { name: 'Retry' }));
    // nothing newer is in the thread, so the question is asked again as an edit of itself
    await waitFor(() => expect(screen.queryByTestId('chat-stalled')).toBeNull(), SLOW);
    await waitFor(
      () =>
        expect(
          db.chatMessagesOf(thread.id).filter((message) => message.supersededAt !== undefined),
        ).not.toHaveLength(0),
      SLOW,
    );
  });
});

describe('PG-1.6 helpers', () => {
  it('copyText joins words, code and JSON', () => {
    expect(
      copyText([
        { type: 'text', text: 'Here:' },
        { type: 'code', language: 'ts', text: 'const a = 1;' },
        { type: 'json', value: { a: 1 } },
      ]),
    ).toBe('Here:\n\nconst a = 1;\n\n{\n  "a": 1\n}');
  });

  it('splitFences gives each fenced block its own code part (with its own Copy)', () => {
    expect(
      splitFences([{ type: 'text', text: 'Try this:\n```ts\nconst a = 1;\n```\nThen run it.' }]),
    ).toEqual([
      { type: 'text', text: 'Try this:' },
      { type: 'code', language: 'ts', text: 'const a = 1;' },
      { type: 'text', text: 'Then run it.' },
    ]);
    expect(splitFences([{ type: 'text', text: 'plain' }])).toEqual([
      { type: 'text', text: 'plain' },
    ]);
  });
});
