import type { DomainUsageSnapshot } from '@ace/contracts';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { TeamPanel } from './TeamPanel';

/*
 * Domain Gate 5, the team panel (D6, D7, D306, D313): each node's state, activity and tokens, the
 * run's totals, budget and cost, per-turn usage — and every estimate marked as one, everywhere.
 */

const RUN = '01ARZ3NDEKTSV4RRFFQ69G5FB0';
const WRITER = '01ARZ3NDEKTSV4RRFFQ69G5N01';
const REVIEW = '01ARZ3NDEKTSV4RRFFQ69G5N02';

const usage: DomainUsageSnapshot = {
  runId: RUN,
  budget: { limit: 1000, used: 850, level: 'WARN' },
  total: { input: 700, output: 150, cachedInput: 300, estimatedShare: 0.2 },
  costEst: { usd: 0.25, source: 'mixed', partial: true },
  perNode: [
    {
      nodeId: WRITER,
      handle: 'writer',
      name: 'Writer',
      brain: false,
      state: 'COMPLETED',
      activity: 'done',
      input: 600,
      output: 80,
      source: 'reported',
      costEst: { usd: 0.25, source: 'reported', partial: false },
      budgetShare: 0.68,
    },
    {
      nodeId: REVIEW,
      handle: 'review',
      name: 'Review',
      brain: false,
      state: 'RUNNING',
      activity: 'thinking',
      input: 100,
      output: 70,
      source: 'estimated',
      costEst: null,
      budgetShare: 0.17,
    },
  ],
  perTurn: [
    {
      turnId: '01ARZ3NDEKTSV4RRFFQ69G5T01',
      nodeId: WRITER,
      input: 600,
      output: 80,
      source: 'reported',
      costEst: { usd: 0.25, source: 'reported', partial: false },
    },
    {
      turnId: '01ARZ3NDEKTSV4RRFFQ69G5T02',
      nodeId: REVIEW,
      input: 100,
      output: 70,
      source: 'estimated',
      costEst: null,
    },
  ],
};

const row = (handle: string) => screen.getByTestId(`team-node-${handle}`);

describe('Domain team panel', () => {
  it("shows each node's state, activity, tokens and budget share; estimates are marked", () => {
    render(<TeamPanel usage={usage} />);
    expect(row('writer')).toHaveTextContent('COMPLETED');
    expect(row('writer')).toHaveTextContent('600');
    expect(row('writer')).toHaveTextContent('68%');
    expect(within(row('writer')).queryByText('est.')).not.toBeInTheDocument();
    expect(row('review')).toHaveTextContent('thinking');
    expect(within(row('review')).getAllByText('est.').length).toBeGreaterThan(0);
    // A node with no price shows "—", never 0.
    expect(row('review')).toHaveTextContent('—');
  });

  it('marks the run totals and the cost as estimates when any part is one', () => {
    render(<TeamPanel usage={usage} />);
    const totals = screen.getByTestId('team-totals');
    expect(totals).toHaveTextContent('700');
    expect(within(totals).getAllByText('est.').length).toBeGreaterThan(0);
    expect(screen.getByTestId('team-cost')).toHaveTextContent('$0.25');
    expect(within(screen.getByTestId('team-cost')).getByText('est.')).toBeInTheDocument();
    const turns = screen.getAllByTestId('team-turn');
    expect(within(turns[1]!).getByText('est.')).toBeInTheDocument();
    expect(within(turns[0]!).queryByText('est.')).not.toBeInTheDocument();
  });

  it('shows the budget and lets the human raise or remove it', async () => {
    const user = userEvent.setup();
    const onSetBudget = vi.fn(async () => undefined);
    render(<TeamPanel usage={usage} onSetBudget={onSetBudget} />);
    expect(screen.getByTestId('team-budget')).toHaveTextContent('850 / 1,000');
    expect(screen.getByTestId('team-budget')).toHaveTextContent('WARN');
    const input = screen.getByRole('spinbutton', { name: 'Token budget' });
    await user.clear(input);
    await user.type(input, '5000');
    await user.click(screen.getByRole('button', { name: 'Set budget' }));
    expect(onSetBudget).toHaveBeenCalledWith(5000);
    await user.click(screen.getByRole('button', { name: 'Remove budget' }));
    expect(onSetBudget).toHaveBeenLastCalledWith(null);
  });

  it('read-only: the numbers stay, the budget cannot be changed', () => {
    render(<TeamPanel usage={usage} readOnly onSetBudget={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Set budget' })).not.toBeInTheDocument();
    expect(screen.getByTestId('team-totals')).toHaveTextContent('700');
  });

  it('no usage yet says so', () => {
    render(<TeamPanel usage={null} />);
    expect(screen.getByText(/no usage yet/i)).toBeInTheDocument();
  });
});
