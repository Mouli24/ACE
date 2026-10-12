import type { NodeState, ServerFrame } from '@ace/contracts';
import { act, screen } from '@testing-library/react';

import { useRunStore } from '../runs/run-store';
import { ChatAside } from './ChatAside';
import { installChatMockServer, renderChat, seedAgentNode } from './test-support';

installChatMockServer();

const RUN = '01RUN0000000000000000000000';
const NODE_RUN = '01NR00000000000000000000000';

const nodeState = (nodeId: string, status: NodeState, seq: number): ServerFrame =>
  ({
    seq,
    type: 'node.state',
    payload: {
      runId: RUN,
      nodeRunId: NODE_RUN,
      nodeId,
      iteration: 1,
      attempt: 1,
      status,
    },
  }) as ServerFrame;
const running = (nodeId: string): ServerFrame => nodeState(nodeId, 'RUNNING', 1);
const token = (delta: string): ServerFrame =>
  ({ type: 'node.token', payload: { runId: RUN, nodeRunId: NODE_RUN, delta } }) as ServerFrame;

beforeEach(() => useRunStore.getState().reset());

describe('D285 a run’s stream is read in the node’s chat (TC-EXE-007, TC-NFR-003)', () => {
  it('shows the node typing, then its text growing with each delta (D335)', async () => {
    const { workflowId, node } = seedAgentNode({ instructions: 'Write a haiku.' });
    renderChat(<ChatAside workflowId={workflowId} />);
    await screen.findByTestId('chat-conversation');

    act(() => {
      useRunStore.getState().begin(workflowId, RUN, 'RUNNING');
      useRunStore.getState().apply(running(node.id));
    });
    // RUNNING with no text yet: the theme's typing row, and no reply row until there is text
    expect(screen.getByTestId('chat-thinking')).toHaveTextContent('Writer is typing…');
    expect(screen.queryByTestId('chat-run-live')).toBeNull();

    act(() => useRunStore.getState().apply(token('The ')));
    expect(screen.getByTestId('chat-run-live')).toHaveTextContent('The');
    expect(screen.getByTestId('chat-typing')).toHaveTextContent('Writer is typing…');
    act(() => useRunStore.getState().apply(token('quick brown')));
    expect(screen.getByTestId('chat-run-live')).toHaveTextContent('The quick brown');

    // the node finished: nobody is typing any more
    act(() => useRunStore.getState().apply(nodeState(node.id, 'COMPLETED', 2)));
    expect(screen.queryByText(/is typing…/)).toBeNull();
    expect(screen.queryByTestId('chat-run-live')).toBeNull();
  });

  it('says it is waiting for approval, without typing, while the node is WAITING', async () => {
    const { workflowId, node } = seedAgentNode({ instructions: 'Write a haiku.' });
    renderChat(<ChatAside workflowId={workflowId} />);
    await screen.findByTestId('chat-conversation');

    act(() => {
      useRunStore.getState().begin(workflowId, RUN, 'RUNNING');
      useRunStore.getState().apply(running(node.id));
      useRunStore.getState().apply(nodeState(node.id, 'WAITING', 2));
    });
    expect(screen.getByTestId('chat-run-live')).toHaveTextContent('Waiting for your approval…');
    expect(screen.queryByText(/is typing…/)).toBeNull();
  });

  /**
   * TC-NFR-003 / NFR-PERF-04: a delta is on screen within 200 ms of its frame. The render runs
   * inside `act`, so this measures the chat's own cost — a change that made it async or throttled
   * would fail here.
   */
  it('paints a delta within 200 ms of receiving it', async () => {
    const { workflowId, node } = seedAgentNode({ instructions: 'Write a haiku.' });
    renderChat(<ChatAside workflowId={workflowId} />);
    await screen.findByTestId('chat-conversation');
    act(() => {
      useRunStore.getState().begin(workflowId, RUN, 'RUNNING');
      useRunStore.getState().apply(running(node.id));
    });

    const started = performance.now();
    act(() => useRunStore.getState().apply(token('a delta that must be visible')));
    const painted = performance.now() - started;

    expect(screen.getByTestId('chat-run-live')).toHaveTextContent('a delta that must be visible');
    expect(painted).toBeLessThan(200);
    console.info(`TC-NFR-003 paint latency (chat): ${painted.toFixed(1)} ms`);
  });
});
