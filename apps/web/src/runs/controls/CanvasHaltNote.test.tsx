import type { Run } from '@ace/contracts';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { api } from '../../app/api';
import { installMockServer, renderWithQuery } from '../../test/app';
import { useRunStore } from '../run-store';
import { CanvasHaltNote } from './CanvasHaltNote';

installMockServer();

afterEach(() => useRunStore.getState().reset());

describe('CanvasHaltNote', () => {
  it('renders the note for a HALTED run of this workflow', () => {
    useRunStore.setState({ workflowId: 'wf1', status: 'HALTED', haltReason: 'failure' });
    render(<CanvasHaltNote workflowId="wf1" />);
    expect(screen.getByTestId('halt-reason')).toHaveAttribute('data-reason', 'failure');
  });

  it('sizes to its text but never past the Canvas, so a narrow Canvas does not fold it to a column', () => {
    useRunStore.setState({ workflowId: 'wf1', status: 'HALTED', haltReason: 'stopped' });
    render(<CanvasHaltNote workflowId="wf1" />);
    const pill = screen.getByTestId('halt-reason').parentElement;
    expect(pill).toHaveClass('w-max', 'max-w-[calc(100%-1.5rem)]', 'left-1/2', '-translate-x-1/2');
  });

  it('sits below the Canvas chrome, so a long note never covers the "…" menu or Add node', () => {
    useRunStore.setState({ workflowId: 'wf1', status: 'HALTED', haltReason: 'budget_exceeded' });
    render(<CanvasHaltNote workflowId="wf1" />);
    // breadcrumb: top 14 + 24; Add node: top 12 + 34 — the pill starts below both
    expect(screen.getByTestId('halt-reason').parentElement).toHaveClass('top-[58px]');
  });

  it('renders nothing for another workflow, a live run, or a halt without a reason', () => {
    useRunStore.setState({ workflowId: 'wf1', status: 'HALTED', haltReason: 'failure' });
    const { rerender } = render(<CanvasHaltNote workflowId="wf2" />);
    expect(screen.queryByTestId('halt-reason')).toBeNull();

    useRunStore.setState({ workflowId: 'wf1', status: 'RUNNING', haltReason: undefined });
    rerender(<CanvasHaltNote workflowId="wf1" />);
    expect(screen.queryByTestId('halt-reason')).toBeNull();

    useRunStore.setState({ workflowId: 'wf1', status: 'HALTED', haltReason: undefined });
    rerender(<CanvasHaltNote workflowId="wf1" />);
    expect(screen.queryByTestId('halt-reason')).toBeNull();
  });
});

describe('[audit W-5] a run blocked mid-run (D305)', () => {
  it('says why, in words with the engine’s detail, and offers Resume', async () => {
    useRunStore.setState({
      workflowId: 'wf1',
      runId: 'run1',
      status: 'BLOCKED',
      blockedReason: 'LOOP_GUARD',
      blockedDetail: 'Writer and Reviewer went back and forth 6 times.',
      allowedActions: ['resume', 'stop'],
    });
    const resume = vi.spyOn(api(), 'resumeRun').mockResolvedValue({} as Run);
    renderWithQuery(<CanvasHaltNote workflowId="wf1" />);
    const note = screen.getByTestId('blocked-reason');
    expect(note).toHaveAttribute('data-reason', 'LOOP_GUARD');
    expect(note).toHaveTextContent('Run blocked — the loop guard stopped two nodes');
    expect(note).toHaveTextContent('Writer and Reviewer went back and forth 6 times.');
    expect(screen.queryByTestId('halt-reason')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(resume).toHaveBeenCalledWith('run1'));
  });

  it('a pre-flight BLOCKED (no reason) is not a mid-run block', () => {
    useRunStore.setState({ workflowId: 'wf1', runId: 'run1', status: 'BLOCKED' });
    renderWithQuery(<CanvasHaltNote workflowId="wf1" />);
    expect(screen.queryByTestId('blocked-reason')).toBeNull();
  });
});
