import type { Run } from '@ace/contracts';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { api } from '../app/api';
import { createNode } from '../nodes/factory';
import { db, installMockServer, renderWithQuery } from '../test/app';
import { RunBar } from './RunBar';
import { useRunStore } from './run-store';

installMockServer();

afterEach(() => {
  useRunStore.getState().reset();
  vi.restoreAllMocks();
});

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

function renderBar({ halted = true }: { halted?: boolean } = {}) {
  const project = db.createProject({ name: 'P' });
  const workflow = db.createWorkflow(project.id, 'F');
  if (halted) haltRun(workflow.id);
  renderWithQuery(
    <MemoryRouter>
      <RunBar workflowId={workflow.id} />
    </MemoryRouter>,
  );
  return workflow;
}

describe('the phone header’s run bar (FR-EXE-001, FR-MOB-001)', () => {
  it('shows the halt note inline: the phone header has no Canvas note beside it', () => {
    renderBar();
    expect(screen.getByTestId('halt-reason')).toBeInTheDocument();
  });

  it('reads the whole state on the chip, in the theme’s status colour', () => {
    renderBar();
    const chip = screen.getByTestId('run-status');
    expect(chip).toHaveAttribute('data-status', 'HALTED');
    expect(chip).toHaveTextContent('run halted · stopped');
    // the words are one flex item beside the dot, so the chip's gap never opens between them
    expect(chip.children).toHaveLength(2);
    expect(chip).toHaveClass('shrink-0', 'whitespace-nowrap', 'rounded-full');
    expect(chip.style.color).toBe('var(--color-status-STOPPED)');
  });

  it('keeps the totals on one line', () => {
    renderBar();
    act(() => useRunStore.setState({ totals: { tokensIn: 12, tokensOut: 10, costUsd: 0 } }));
    expect(screen.getByTestId('run-totals')).toHaveTextContent('12↓ 10↑ $0.0000');
    expect(screen.getByTestId('run-totals')).toHaveClass(
      'shrink-0',
      'whitespace-nowrap',
      'text-[var(--muted)]',
    );
  });

  it('shows "▶ Run" and is named "Start run"; the visible word is in the name (WCAG 2.5.3)', () => {
    renderBar();
    const button = screen.getByRole('button', { name: 'Start run' });
    expect(button).toHaveTextContent('▶ Run');
    expect(within(button).getByText('▶')).toHaveAttribute('aria-hidden');
    expect(button.getAttribute('aria-label')?.toLowerCase()).toContain('run');
  });

  it('offers no Start while this workflow’s run is in flight', () => {
    const workflow = renderBar({ halted: false });
    act(() =>
      useRunStore.setState({
        workflowId: workflow.id,
        runId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        status: 'RUNNING',
        allowedActions: ['pause', 'stop'],
        active: true,
      }),
    );
    expect(screen.queryByRole('button', { name: 'Start run' })).toBeNull();
  });

  it('starts through the shared start flow, asking an empty Input node for text first', async () => {
    const user = userEvent.setup();
    const project = db.createProject({ name: 'P' });
    const workflow = db.createWorkflow(project.id, 'F');
    const input = createNode('input', workflow.id, { x: 0, y: 0 });
    db.commitGraph(workflow.id, [input], []);
    const start = vi
      .spyOn(api(), 'startRun')
      .mockResolvedValue({ id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', status: 'RUNNING' } as Run);
    renderWithQuery(
      <MemoryRouter>
        <RunBar workflowId={workflow.id} />
      </MemoryRouter>,
    );
    await waitFor(async () => {
      await user.click(screen.getByRole('button', { name: 'Start run' }));
      expect(await screen.findByTestId('run-input-dialog')).toBeInTheDocument();
    });
    const dialog = screen.getByTestId('run-input-dialog');
    await user.type(within(dialog).getByRole('textbox'), 'go');
    await user.click(within(dialog).getByRole('button', { name: 'Start run' }));
    await waitFor(() =>
      expect(start).toHaveBeenCalledWith(workflow.id, {
        inputs: { [input.id]: [{ type: 'text', text: 'go' }] },
      }),
    );
  });
});
