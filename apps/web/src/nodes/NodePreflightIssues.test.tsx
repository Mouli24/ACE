import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createNode } from './factory';
import { NodePreflightIssues } from './NodePreflightIssues';
import { useRunStore } from '../runs/run-store';

const getRun = vi.fn();
vi.mock('../app/api', () => ({ api: () => ({ getRun }) }));

const WF = 'wf-1';

function renderWithQuery(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(() => useRunStore.getState().reset());
afterEach(() => {
  useRunStore.getState().reset();
  vi.clearAllMocks();
});

describe('NodePreflightIssues (FR-MM-005)', () => {
  it('TC-MM-005: shows an incompatible_model issue for this node with the model name', async () => {
    const node = createNode('agent', WF, { x: 0, y: 0 });
    getRun.mockResolvedValue({
      preflightIssues: [
        {
          severity: 'error',
          code: 'incompatible_model',
          message: '"Mock text" does not handle the data types "Agent" is configured for.',
          nodeId: node.id,
        },
      ],
    });
    useRunStore.getState().begin(WF, 'run-1', 'BLOCKED');

    renderWithQuery(<NodePreflightIssues node={node} />);

    const alert = await screen.findByTestId(`node-preflight-${node.id}`);
    expect(alert).toHaveTextContent(/does not handle the data types/i);
    expect(alert).toHaveTextContent(/Mock text/);
    expect(alert.querySelector('[data-code="incompatible_model"]')).not.toBeNull();
  });

  it('shows nothing when the run is not BLOCKED', () => {
    const node = createNode('agent', WF, { x: 0, y: 0 });
    useRunStore.getState().begin(WF, 'run-1', 'RUNNING');
    renderWithQuery(<NodePreflightIssues node={node} />);
    expect(screen.queryByTestId(`node-preflight-${node.id}`)).not.toBeInTheDocument();
  });

  it('shows nothing for a node the issues do not name', async () => {
    const node = createNode('agent', WF, { x: 0, y: 0 });
    getRun.mockResolvedValue({
      preflightIssues: [
        { severity: 'error', code: 'incompatible_model', message: 'x', nodeId: 'other-node' },
      ],
    });
    useRunStore.getState().begin(WF, 'run-1', 'BLOCKED');
    renderWithQuery(<NodePreflightIssues node={node} />);
    // Let the query resolve, then confirm this node's echo stays absent.
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId(`node-preflight-${node.id}`)).not.toBeInTheDocument();
  });
});
