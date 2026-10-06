import { act, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { db, installMockServer, renderWithQuery } from '../test/app';
import { RunBar } from './RunBar';
import { useRunStore } from './run-store';

installMockServer();

afterEach(() => useRunStore.getState().reset());

function haltRun(workflowId: string) {
  useRunStore.setState({
    workflowId,
    runId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    status: 'HALTED',
    haltReason: 'stopped',
    allowedActions: ['restart'],
    active: false,
  });
}

function renderBar(haltInline?: boolean) {
  const project = db.createProject({ name: 'P' });
  const workflow = db.createWorkflow(project.id, 'F');
  haltRun(workflow.id);
  renderWithQuery(
    <MemoryRouter>
      <RunBar workflowId={workflow.id} {...(haltInline === undefined ? {} : { haltInline })} />
    </MemoryRouter>,
  );
}

describe('RunBar halt note placement (Review Focus 5)', () => {
  it('shows the halt note inline by default, as the compact header does', () => {
    renderBar();
    expect(screen.getByTestId('halt-reason')).toBeInTheDocument();
  });

  it('shows no halt note when haltInline is false, the Canvas carries it', () => {
    renderBar(false);
    expect(screen.queryByTestId('halt-reason')).toBeNull();
    expect(screen.getByTestId('run-status')).toHaveAttribute('data-status', 'HALTED');
  });

  it('the chip folds "run" and the halt reason away between phone width and lg; its text stays whole', () => {
    renderBar(false);
    const chip = screen.getByTestId('run-status');
    expect(chip).toHaveTextContent('run halted · stopped');
    // only on the desktop bar's narrow band, where the Canvas's halt note says why; the phone
    // header (≤ 640 px) keeps the whole label
    // visually hidden, never display:none, so a screen reader still hears "run halted · stopped"
    expect(within(chip).getByText('run')).toHaveClass('min-[641px]:max-lg:sr-only');
    expect(within(chip).getByText('· stopped')).toHaveClass('min-[641px]:max-lg:sr-only');
    // the words are one flex item beside the dot, so the chip's gap never opens between them
    expect(chip.children).toHaveLength(2);
    // a tight bar never squeezes the chip or the totals onto two lines; the workflow tabs give way
    expect(chip).toHaveClass('shrink-0', 'whitespace-nowrap');
  });

  it('keeps the totals on one line', () => {
    renderBar(false);
    act(() => useRunStore.setState({ totals: { tokensIn: 12, tokensOut: 10, costUsd: 0 } }));
    expect(screen.getByTestId('run-totals')).toHaveTextContent('12↓ 10↑ $0.0000');
    expect(screen.getByTestId('run-totals')).toHaveClass('shrink-0', 'whitespace-nowrap');
  });

  it('never shrinks on the desktop bar, so its controls cannot spill over the bar’s other items', () => {
    renderBar(false);
    // the phone header gives the run bar a scrolling row of its own instead
    expect(screen.getByTestId('run-bar')).toHaveClass('min-[641px]:shrink-0');
  });

  it('shows "Run" and is named "Start run" (WCAG 2.5.3: the visible text is in the name)', () => {
    renderBar();
    const button = screen.getByRole('button', { name: 'Start run' });
    expect(button).toHaveTextContent('Run');
    expect(button.getAttribute('aria-label')?.toLowerCase()).toContain(
      (button.textContent ?? '').trim().toLowerCase(),
    );
  });
});
