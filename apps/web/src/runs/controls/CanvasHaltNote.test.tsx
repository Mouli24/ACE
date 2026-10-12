import { render, screen } from '@testing-library/react';

import { useRunStore } from '../run-store';
import { CanvasHaltNote } from './CanvasHaltNote';

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
