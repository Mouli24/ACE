import { STATUS_RING } from '@ace/ui';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { findBlockingNodeId, type UpstreamEdge } from './blocked';
import { ErrorsTab, type ErrorsTabNodeRun } from './ErrorsTab';
import { countByState, failureCount } from './RunSummary';

const A = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const B = '01BRZ3NDEKTSV4RRFFQ69G5FAV';
const C = '01CRZ3NDEKTSV4RRFFQ69G5FAV';

const NODES = [
  { id: A, name: 'Writer' },
  { id: B, name: 'Reviewer' },
  { id: C, name: 'Result' },
];

/** A → B → C, the shape TC-ERR-007 uses: A fails, B and C are BLOCKED. */
const EDGES: UpstreamEdge[] = [
  { kind: 'data', from: { nodeId: A }, to: { nodeId: B } },
  { kind: 'data', from: { nodeId: B }, to: { nodeId: C } },
];

const nodeRun = (nodeId: string, status: ErrorsTabNodeRun['status']): ErrorsTabNodeRun => ({
  nodeRunId: `run-${nodeId}`,
  nodeId,
  status,
});

describe('TC-ERR-007 downstream of a failure is BLOCKED, and says by whom', () => {
  it('greys the blocked nodes, locks them and names the node that failed (FR-ERR-006)', () => {
    render(
      <ErrorsTab
        nodes={NODES}
        edges={EDGES}
        nodeRuns={[
          {
            ...nodeRun(A, 'FAILED'),
            failureReason: 'RUN_FAILED',
            error: {
              kind: 'provider',
              code: 'provider_503',
              message: 'Service Unavailable',
              retryable: true,
            },
          },
          nodeRun(B, 'BLOCKED'),
          nodeRun(C, 'BLOCKED'),
        ]}
      />,
    );

    for (const nodeId of [B, C]) {
      const note = screen.getByTestId(`blocked-note-${nodeId}`);
      expect(note).toHaveAttribute('data-state', 'BLOCKED');
      expect(note).toHaveTextContent('blocked by Writer');
      expect(note.className).toContain('opacity-70'); // greyed
      expect(screen.getAllByLabelText('blocked').length).toBeGreaterThan(0); // the lock
      // FR-ERR-006: BLOCKED is shown as BLOCKED — never as a failure.
      expect(note).not.toHaveTextContent(/failed/i);
    }
    expect(screen.queryByTestId(`error-card-${B}`)).not.toBeInTheDocument();
  });

  it('finds the nearest failure upstream and never follows a loop edge backwards', () => {
    expect(findBlockingNodeId(C, EDGES, new Set([A]))).toBe(A);
    expect(findBlockingNodeId(C, EDGES, new Set([A, B]))).toBe(B); // the nearer one
    expect(findBlockingNodeId(B, EDGES, new Set([C]))).toBeUndefined(); // C is downstream
    // A loop edge points back from C to A; following it would name a node after B, not before it.
    const withLoop: UpstreamEdge[] = [
      ...EDGES,
      { kind: 'loop', from: { nodeId: C }, to: { nodeId: A } },
    ];
    expect(findBlockingNodeId(A, withLoop, new Set([C]))).toBeUndefined();
  });

  it('says so plainly when nothing upstream explains the block', () => {
    render(<ErrorsTab nodes={NODES} nodeRuns={[nodeRun(B, 'BLOCKED')]} />);
    expect(screen.getByTestId(`blocked-note-${B}`)).toHaveTextContent('blocked upstream');
  });
});

describe('TC-ERR-008 a cancellation is not a failure', () => {
  it('counts stopped nodes apart from failures and never colours them red (FR-ERR-007)', () => {
    render(
      <ErrorsTab
        nodes={NODES}
        edges={EDGES}
        nodeRuns={[nodeRun(A, 'COMPLETED'), nodeRun(B, 'STOPPED'), nodeRun(C, 'STOPPED')]}
        haltReason="stopped"
      />,
    );

    const summary = screen.getByTestId('run-summary');
    expect(summary).toHaveAttribute('data-failed', '0');
    expect(summary).toHaveAttribute('data-stopped', '2');
    expect(screen.getByTestId('run-summary-failed')).toHaveTextContent('0 failed');
    expect(screen.getByTestId('run-summary-stopped')).toHaveTextContent('2 stopped');
    expect(screen.getByTestId('errors-tab-no-failures')).toBeInTheDocument();

    const note = screen.getByTestId(`stopped-note-${B}`);
    expect(note).toHaveAttribute('data-state', 'STOPPED');
    expect(note).toHaveTextContent('not a failure');
    expect(note.className).not.toMatch(/danger|red/);
    expect(note.innerHTML).not.toMatch(/danger/);
    // The stopped ring colour is the neutral token, never the failed one (round 1 tokens).
    expect(STATUS_RING.STOPPED).not.toBe(STATUS_RING.FAILED);

    // The halt itself reads as a choice, not a fault (FR-CTL-003, NFR-USE-03).
    expect(screen.getByTestId('halt-reason')).toHaveTextContent('stopped by you');
  });

  it('counts each state on its own, so no ending is folded into another', () => {
    const counts = countByState([
      nodeRun(A, 'FAILED'),
      nodeRun(B, 'STOPPED'),
      nodeRun(C, 'BLOCKED'),
    ]);
    expect([counts.FAILED, counts.STOPPED, counts.BLOCKED, counts.COMPLETED]).toEqual([1, 1, 1, 0]);
    expect(failureCount([nodeRun(A, 'STOPPED'), nodeRun(B, 'BLOCKED')])).toBe(0);
  });
});

describe('TC-ERR-002 the Errors tab lists the run failures with a retry', () => {
  it('retries the node run the card belongs to, and can show its node', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const onShowNode = vi.fn();
    render(
      <ErrorsTab
        nodes={NODES}
        edges={EDGES}
        nodeRuns={[
          {
            ...nodeRun(A, 'FAILED'),
            attempt: 1,
            failureReason: 'GUARDRAIL_VIOLATION',
            error: {
              kind: 'guardrail',
              code: 'guardrail_blocked',
              message: 'secret_leak blocked this output',
              retryable: false,
              providerId: B,
            },
          },
        ]}
        providerNames={{ [B]: 'Mock' }}
        onRetry={onRetry}
        onShowNode={onShowNode}
      />,
    );

    expect(screen.getByTestId(`error-card-${A}`)).toHaveTextContent('GUARDRAIL_VIOLATION');
    expect(screen.getByTestId(`error-next-step-${A}`)).toHaveTextContent('verdicts');
    expect(screen.getByTestId(`error-provider-${A}`)).toHaveTextContent('Mock');

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledExactlyOnceWith(`run-${A}`, A);
    await user.click(screen.getByRole('button', { name: 'show node' }));
    expect(onShowNode).toHaveBeenCalledExactlyOnceWith(A);
  });

  it('says a failure has no detail yet rather than inventing a kind', () => {
    render(
      <ErrorsTab
        nodes={NODES}
        nodeRuns={[{ ...nodeRun(A, 'FAILED'), failureReason: 'CONTRACT_VIOLATION' }]}
      />,
    );
    expect(screen.getByTestId(`error-without-detail-${A}`)).toHaveTextContent('CONTRACT_VIOLATION');
    expect(screen.queryByTestId(`error-card-${A}`)).not.toBeInTheDocument();
  });

  it('has nothing to report before a run touches a node', () => {
    render(<ErrorsTab nodes={NODES} nodeRuns={[]} />);
    expect(screen.getByTestId('errors-tab')).toHaveTextContent('No node has run yet');
  });
});
