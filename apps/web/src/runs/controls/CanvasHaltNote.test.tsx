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
