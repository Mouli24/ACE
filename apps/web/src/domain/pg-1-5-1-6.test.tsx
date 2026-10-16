import { AgentConfigSchema, rosterFor, type DomainMessage, type Node } from '@ace/contracts';
import { AceApiError } from '@ace/sdk';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { configureApi } from '../app/api';
import { Composer } from './Composer';
import { Conversation } from './Conversation';

configureApi({ token: 'mock', baseUrl: 'http://mock.local' });

/*
 * PG-1.5 / PG-1.6 in Domain (D303: a projection of the log, so Copy, node Retry and Resend only).
 */

const RUN = '01ARZ3NDEKTSV4RRFFQ69G5FB0';
const WF = '01ARZ3NDEKTSV4RRFFQ69G5FAW';
const WRITER = '01ARZ3NDEKTSV4RRFFQ69G5N01';
const NODE_RUN = '01ARZ3NDEKTSV4RRFFQ69G5R01';
const NOW = '2026-10-15T00:00:00.000Z';

const writer: Node = {
  id: WRITER,
  workflowId: WF,
  kind: 'agent',
  name: 'Writer',
  position: { x: 0, y: 0 },
  inputs: [],
  outputs: [],
  config: AgentConfigSchema.parse({
    instructions: '',
    inputTypes: ['text'],
    outputTypes: ['text'],
  }),
};
const roster = rosterFor([writer]);

const human: DomainMessage = {
  id: 'human:1',
  runId: RUN,
  cursor: '1.0',
  author: { kind: 'human' },
  type: 'human',
  text: '@writer Write a tagline',
  to: [WRITER],
  at: NOW,
};
const system: DomainMessage = {
  id: 'system:1',
  runId: RUN,
  cursor: '2.0',
  author: { kind: 'system' },
  type: 'system',
  text: 'The run started.',
  at: NOW,
};
const failed: DomainMessage = {
  id: `turn:${NODE_RUN}`,
  runId: RUN,
  cursor: '3.0',
  author: { kind: 'node', nodeId: WRITER },
  type: 'agent',
  text: 'Output did not match the schema.',
  at: NOW,
  turn: {
    turnId: NODE_RUN,
    trigger: 'dispatch',
    iteration: 1,
    attempt: 1,
    steps: [],
    outcome: 'FAILED',
    failureReason: 'CONTRACT_VIOLATION',
    error: 'Output did not match the schema.',
  },
};

function conversation(onRetryTurn?: (turnId: string) => Promise<unknown>) {
  return render(
    <Conversation
      messages={[human, system, failed]}
      roster={roster}
      tokens={{}}
      readOnly={false}
      onRoute={vi.fn()}
      {...(onRetryTurn === undefined ? {} : { onRetryTurn })}
    />,
  );
}

describe('PG-1.6 Domain: every message offers Copy', () => {
  it('a human, a system and an agent message each have Copy, which copies its text', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    conversation();
    const rows = screen.getAllByTestId('domain-message');
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(within(row).getByRole('button', { name: 'Copy' })).toBeInTheDocument();
    }
    await user.click(within(rows[0]!).getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith('@writer Write a tagline');
    // No edit or delete: Domain is a projection of the run's log.
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit & resend' })).toBeNull();
  });
});

describe('PG-1.5 Domain: a failed node turn says why in words, with Retry', () => {
  it('names the failure reason and retries the node run', async () => {
    const user = userEvent.setup();
    const onRetryTurn = vi.fn(async () => undefined);
    conversation(onRetryTurn);
    const failure = screen.getByTestId('domain-turn-failure');
    expect(failure).toHaveTextContent(/contract violation/i);
    expect(failure).toHaveAttribute('data-reason', 'CONTRACT_VIOLATION');
    await user.click(within(failure).getByRole('button', { name: 'Retry' }));
    expect(onRetryTurn).toHaveBeenCalledWith(NODE_RUN);
  });

  it('a refused retry says why, and offers it again', async () => {
    const user = userEvent.setup();
    const onRetryTurn = vi.fn(async () => {
      throw new Error('A run that is RUNNING cannot retry a node.');
    });
    conversation(onRetryTurn);
    const failure = screen.getByTestId('domain-turn-failure');
    await user.click(within(failure).getByRole('button', { name: 'Retry' }));
    expect(await within(failure).findByText(/cannot retry a node/)).toBeInTheDocument();
    expect(within(failure).getByRole('button', { name: 'Retry' })).toBeEnabled();
  });

  it('without a retry handler there is no Retry, only the reason', () => {
    conversation();
    expect(screen.getByTestId('domain-turn-failure')).toHaveTextContent(/contract violation/i);
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});

describe('PG-1.5 Domain composer: a failed post keeps its text', () => {
  it('a post that fails on the wire keeps the text, and Resend sends it again', async () => {
    const user = userEvent.setup();
    const onSend = vi
      .fn()
      .mockRejectedValueOnce(new Error('Failed to fetch'))
      .mockResolvedValueOnce(undefined);
    render(<Composer roster={roster} states={{}} live onSend={onSend} onStart={vi.fn()} />);
    const box = screen.getByRole('textbox', { name: 'Message' });
    await user.type(box, '@writer Write a tagline{Enter}');
    const resend = await screen.findByRole('button', { name: 'Resend' });
    expect(box).toHaveValue('@writer Write a tagline');
    await user.click(resend);
    expect(onSend).toHaveBeenCalledTimes(2);
    expect(box).toHaveValue('');
    expect(screen.queryByRole('button', { name: 'Resend' })).toBeNull();
  });

  it('a run that failed to start keeps its goal, with Resend', async () => {
    const user = userEvent.setup();
    const onStart = vi.fn().mockRejectedValueOnce(new Error('Failed to fetch'));
    render(
      <Composer roster={roster} states={{}} live={false} onSend={vi.fn()} onStart={onStart} />,
    );
    const box = screen.getByRole('textbox', { name: 'Message' });
    await user.type(box, 'Write a tagline{Enter}');
    expect(await screen.findByRole('button', { name: 'Resend' })).toBeInTheDocument();
    expect(box).toHaveValue('Write a tagline');
  });

  it('a 409 says the run has ended and offers to start a new run with the message', async () => {
    const user = userEvent.setup();
    const ended = new AceApiError(409, {
      kind: 'workflow',
      code: 'invalid_run_state',
      message: 'The run is COMPLETE — it has ended, so it takes no more messages.',
      retryable: false,
    });
    const onSend = vi.fn().mockRejectedValueOnce(ended);
    const onStart = vi.fn(async () => undefined);
    render(<Composer roster={roster} states={{}} live onSend={onSend} onStart={onStart} />);
    const box = screen.getByRole('textbox', { name: 'Message' });
    await user.type(box, '@writer One more idea{Enter}');

    expect(await screen.findByText(/This run has ended/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resend' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Start a new run with this message' }));
    expect(onStart).toHaveBeenCalledWith('@writer One more idea');
    expect(box).toHaveValue('');
  });
});
