import type { DomainUsageSnapshot } from '@ace/contracts';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { DomainLook } from './looks';
import { TeamPanel } from './TeamPanel';

/*
 * Domain Gate 5, the Team aside (D6, D7, D306, D313) in the theme (D336): each agent's state pill,
 * activity, model, tokens and budget share; the run's TOKEN USE — total against the budget, input,
 * output, the cost tile only when a cost is known, the last turns — and every estimate marked as
 * one, everywhere.
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

const looks = new Map<string, DomainLook>([
  [WRITER, { color: '#ef6b3f', letter: 'W', model: 'claude-sonnet' }],
  [REVIEW, { color: '#7a62d6', letter: 'R', model: undefined }],
]);

const card = (handle: string) => screen.getByTestId(`team-node-${handle}`);
const state = (handle: string) => within(card(handle)).getByTestId('team-node-state');

describe('Domain Team aside', () => {
  it('counts the agents and the ones working', () => {
    render(<TeamPanel usage={usage} looks={looks} />);
    expect(screen.getByRole('complementary', { name: 'Team' })).toHaveTextContent(
      '2 agents · 1 working',
    );
  });

  it("shows each agent's state pill, activity, model, tokens and budget share", () => {
    render(<TeamPanel usage={usage} looks={looks} />);
    expect(state('writer')).toHaveTextContent('Done');
    expect(state('review')).toHaveTextContent('Working');
    expect(card('writer')).toHaveTextContent('@writer · claude-sonnet');
    // No model configured: "—", never a made-up one.
    expect(card('review')).toHaveTextContent('@review · —');
    expect(card('review')).toHaveTextContent('thinking');
    // Tokens: the total, then in / out.
    expect(card('writer')).toHaveTextContent('Tokens680600 / 80');
    expect(within(card('writer')).getByTestId('team-node-bar')).toHaveStyle({ width: '68%' });
    expect(within(card('review')).getByTestId('team-node-bar')).toHaveStyle({ width: '17%' });
  });

  it('marks estimated tokens, and a cost nobody knows is left out, never shown as 0', () => {
    render(<TeamPanel usage={usage} looks={looks} />);
    expect(within(card('writer')).queryByText('est.')).not.toBeInTheDocument();
    expect(within(card('writer')).getByText('reported')).toBeInTheDocument();
    expect(within(card('review')).getAllByText('est.').length).toBeGreaterThan(0);
    // D306: an unknown cost is never 0; the theme's card has no cost row, so it is simply absent
    expect(card('review')).not.toHaveTextContent('Cost');
    expect(card('review')).not.toHaveTextContent('$0');
  });

  it('maps every node state to its pill', () => {
    const states = [
      ['IDLE', 'Waiting'],
      ['READY', 'Waiting'],
      ['WAITING', 'Waiting'],
      ['PAUSED', 'Waiting'],
      ['FAILED', 'Failed'],
      ['BLOCKED', 'Blocked'],
      ['STOPPED', 'Stopped'],
    ] as const;
    for (const [node, label] of states) {
      const { unmount } = render(
        <TeamPanel
          usage={{ ...usage, perNode: [{ ...usage.perNode[0]!, state: node }] }}
          looks={looks}
        />,
      );
      expect(state('writer')).toHaveTextContent(label);
      unmount();
    }
  });

  it("TOKEN USE: the run's total against the budget, input and output, estimates marked", () => {
    render(<TeamPanel usage={usage} looks={looks} />);
    const totals = screen.getByTestId('team-totals');
    expect(totals).toHaveTextContent('TOKEN USE');
    expect(totals).toHaveTextContent('850');
    expect(totals).toHaveTextContent('of 1k budget');
    expect(within(totals).getAllByText('est.').length).toBeGreaterThan(0);
    expect(within(totals).getByText('Input').parentElement).toHaveTextContent('Input700');
    expect(within(totals).getByText('Output').parentElement).toHaveTextContent('Output150');
  });

  it('shows the cost tile only when a cost is known, at least / est. as D306 has it', () => {
    const { unmount } = render(<TeamPanel usage={usage} looks={looks} />);
    const cost = screen.getByTestId('team-cost');
    expect(cost).toHaveTextContent('Est. cost');
    expect(cost).toHaveTextContent('at least$0.25est.');
    unmount();

    render(<TeamPanel usage={{ ...usage, costEst: null }} looks={looks} />);
    expect(screen.queryByTestId('team-cost')).not.toBeInTheDocument();
    expect(screen.queryByText('Est. cost')).not.toBeInTheDocument();
  });

  it('a reported cost says reported', () => {
    render(
      <TeamPanel
        usage={{ ...usage, costEst: { usd: 0.25, source: 'reported', partial: false } }}
        looks={looks}
      />,
    );
    expect(screen.getByTestId('team-cost')).toHaveTextContent('$0.25reported');
  });

  it('per turn: a bar per turn in its agent colour, the estimated ones say so', () => {
    render(<TeamPanel usage={usage} looks={looks} />);
    expect(screen.getByText('last 2')).toBeInTheDocument();
    const turns = screen.getAllByTestId('team-turn');
    expect(turns).toHaveLength(2);
    expect(turns[0]).toHaveAttribute('title', 'Writer · 1k');
    expect(turns[0]).toHaveStyle({ height: '100%', background: '#ef6b3f' });
    expect(turns[1]).toHaveAttribute('title', 'Review · 0k est.');
    expect(turns[1]).toHaveStyle({ background: '#7a62d6' });
  });

  it('keeps only the last 12 turns', () => {
    const many = Array.from({ length: 15 }, (_, index) => ({
      ...usage.perTurn[0]!,
      turnId: `01ARZ3NDEKTSV4RRFFQ69G5T${String(index).padStart(2, '0')}`,
    }));
    render(<TeamPanel usage={{ ...usage, perTurn: many }} looks={looks} />);
    expect(screen.getAllByTestId('team-turn')).toHaveLength(12);
    expect(screen.getByText('last 12')).toBeInTheDocument();
  });

  it('without a budget it says so, and the bars share the total', () => {
    render(<TeamPanel usage={{ ...usage, budget: null }} looks={looks} />);
    expect(screen.getByTestId('team-totals')).toHaveTextContent('no budget set');
  });

  it('shows the budget level and lets the human raise or remove it', async () => {
    const user = userEvent.setup();
    const onSetBudget = vi.fn(async () => undefined);
    render(<TeamPanel usage={usage} looks={looks} onSetBudget={onSetBudget} />);
    expect(screen.getByTestId('team-budget')).toHaveTextContent('WARN · 850 / 1,000 tokens');
    const input = screen.getByRole('spinbutton', { name: 'Token budget' });
    await user.clear(input);
    await user.type(input, '5000');
    await user.click(screen.getByRole('button', { name: 'Set budget' }));
    expect(onSetBudget).toHaveBeenCalledWith(5000);
    await user.click(screen.getByRole('button', { name: 'Remove budget' }));
    expect(onSetBudget).toHaveBeenLastCalledWith(null);
  });

  it('read-only: the numbers stay, the budget cannot be changed', () => {
    render(<TeamPanel usage={usage} looks={looks} readOnly onSetBudget={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Set budget' })).not.toBeInTheDocument();
    expect(screen.getByTestId('team-totals')).toHaveTextContent('850');
  });

  it('the close button closes the aside', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<TeamPanel usage={usage} looks={looks} onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('no usage yet says so, and the tiles show "—"', () => {
    render(<TeamPanel usage={null} agentCount={3} />);
    expect(screen.getByText(/no usage yet/i)).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Team' })).toHaveTextContent(
      '3 agents · 0 working',
    );
    const totals = screen.getByTestId('team-totals');
    expect(within(totals).getByText('Input').parentElement).toHaveTextContent('Input—');
    expect(within(totals).getByText('Output').parentElement).toHaveTextContent('Output—');
    expect(screen.queryByTestId('team-cost')).not.toBeInTheDocument();
  });

  it('a run with no agents says so', () => {
    render(<TeamPanel usage={{ ...usage, perNode: [], perTurn: [] }} />);
    expect(screen.getByText('No agents in this run')).toBeInTheDocument();
  });
});
