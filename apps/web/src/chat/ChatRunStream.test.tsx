import type { ServerFrame } from '@ace/contracts';
import { act, screen } from '@testing-library/react';

import { useRunStore } from '../runs/run-store';
import { ChatAside } from './ChatAside';
import { installChatMockServer, renderChat, seedAgentNode } from './test-support';

installChatMockServer();

const RUN = '01RUN0000000000000000000000';
const NODE_RUN = '01NR00000000000000000000000';

const running = (nodeId: string): ServerFrame =>
  ({
    seq: 1,
    type: 'node.state',
    payload: {
      runId: RUN,
      nodeRunId: NODE_RUN,
      nodeId,
      iteration: 1,
      attempt: 1,
      status: 'RUNNING',
    },
  }) as ServerFrame;
const token = (delta: string): ServerFrame =>
  ({ type: 'node.token', payload: { runId: RUN, nodeRunId: NODE_RUN, delta } }) as ServerFrame;

beforeEach(() => useRunStore.getState().reset());

describe('D285 a run’s stream is read in the node’s chat (TC-EXE-007, TC-NFR-003)', () => {
  it('shows the node working, then its text growing with each delta', async () => {
    const { workflowId, node } = seedAgentNode({ instructions: 'Write a haiku.' });
    renderChat(<ChatAside workflowId={workflowId} />);
    await screen.findByTestId('chat-conversation');

    act(() => {
      useRunStore.getState().begin(workflowId, RUN, 'RUNNING');
      useRunStore.getState().apply(running(node.id));
    });
    expect(screen.getByTestId('chat-run-live')).toHaveTextContent('Working on its goal…');

    act(() => useRunStore.getState().apply(token('The ')));
    expect(screen.getByTestId('chat-run-live')).toHaveTextContent('The');
    act(() => useRunStore.getState().apply(token('quick brown')));
    expect(screen.getByTestId('chat-run-live')).toHaveTextContent('The quick brown');
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
