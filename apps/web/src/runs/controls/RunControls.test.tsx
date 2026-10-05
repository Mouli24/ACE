import { RUN_ACTIONS, RUN_STATES, allowedRunActions, type RunAction } from '@ace/contracts';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { NodeRunMenu } from './NodeRunMenu';
import { RunControls } from './RunControls';

const RUN = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const NEW_RUN = '01BRZ3NDEKTSV4RRFFQ69G5FAV';
const NODE = '01CRZ3NDEKTSV4RRFFQ69G5FAV';
const NODE_RUN = '01DRZ3NDEKTSV4RRFFQ69G5FAV';

/** Which of the four buttons the DOM says are usable right now. */
function enabledActions(): RunAction[] {
  return RUN_ACTIONS.filter(
    (action) => !screen.getByTestId(`run-action-${action}`).hasAttribute('disabled'),
  );
}

describe('TC-CTL-006 the run controls are enabled strictly from run.allowedActions', () => {
  it.each(RUN_STATES)(
    'a %s run enables exactly what the engine listed for it (FR-CTL-006)',
    (status) => {
      const allowed = allowedRunActions(status);
      render(
        <RunControls runId={RUN} status={status} allowedActions={allowed} onAction={vi.fn()} />,
      );
      expect(enabledActions()).toEqual(RUN_ACTIONS.filter((action) => allowed.includes(action)));
    },
  );

  it('follows the engine even when the list disagrees with the status — nothing is inferred', () => {
    // A RUNNING run whose engine allows nothing: every button is off, though the state machine
    // would say pause and stop. This is the assertion that fails if the UI ever guesses.
    const { unmount } = render(
      <RunControls runId={RUN} status="RUNNING" allowedActions={[]} onAction={vi.fn()} />,
    );
    expect(enabledActions()).toEqual([]);
    unmount();

    // And the other way round: a PAUSED run the engine says may only be paused.
    render(
      <RunControls runId={RUN} status="PAUSED" allowedActions={['pause']} onAction={vi.fn()} />,
    );
    expect(enabledActions()).toEqual(['pause']);
  });

  it('turns everything off when the run carries no allowedActions at all, and says so', () => {
    render(<RunControls runId={RUN} status="RUNNING" onAction={vi.fn()} />);
    expect(enabledActions()).toEqual([]);
    expect(screen.getByTestId('run-controls-unknown')).toBeInTheDocument();
  });

  it('sends pause and resume straight through (FR-CTL-001, FR-CTL-002)', async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    render(
      <RunControls
        runId={RUN}
        status="RUNNING"
        allowedActions={['pause', 'resume', 'stop', 'restart']}
        onAction={onAction}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Pause' }));
    expect(onAction).toHaveBeenLastCalledWith('pause');
    await user.click(screen.getByRole('button', { name: 'Resume' }));
    expect(onAction).toHaveBeenLastCalledWith('resume');
  });
});

describe('FR-CTL-003 Stop asks before it cancels anything', () => {
  it('does not send the stop until it is confirmed, and not at all if it is waved off', async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    render(
      <RunControls runId={RUN} status="RUNNING" allowedActions={['stop']} onAction={onAction} />,
    );

    await user.click(screen.getByRole('button', { name: 'Stop' }));
    expect(screen.getByTestId('stop-confirm')).toBeInTheDocument();
    expect(onAction).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Keep running' }));
    expect(onAction).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Stop' }));
    await user.click(screen.getByRole('button', { name: 'Stop the run' }));
    expect(onAction).toHaveBeenCalledExactlyOnceWith('stop');
  });
});

describe('FR-CTL-004 Restart shows the new run the engine answered with', () => {
  it('opens the new run id, not the one that was restarted', async () => {
    const user = userEvent.setup();
    const onOpenRun = vi.fn();
    render(
      <RunControls
        runId={RUN}
        status="HALTED"
        allowedActions={['restart']}
        onAction={vi.fn().mockResolvedValue({ id: NEW_RUN })}
        onOpenRun={onOpenRun}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Restart' }));
    expect(onOpenRun).toHaveBeenCalledExactlyOnceWith(NEW_RUN);
    expect(await screen.findByTestId('run-restarted')).toHaveTextContent('Restarted as a new run');
  });
});

describe('FR-ERR-003/004, FR-CTL-005, FR-EXE-013 the node-level controls', () => {
  const callbacks = () => ({
    onRetry: vi.fn(),
    onRetryWithDownstream: vi.fn(),
    onRerunNode: vi.fn(),
    onStartFromNode: vi.fn(),
  });

  it('offers Retry, Retry with downstream, Re-run this node and Start from this node', async () => {
    const user = userEvent.setup();
    const handlers = callbacks();
    render(
      <NodeRunMenu
        nodeId={NODE}
        nodeName="Writer"
        state="FAILED"
        nodeRunId={NODE_RUN}
        {...handlers}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Run actions for Writer' }));

    for (const [name, handler] of [
      ['Retry', handlers.onRetry],
      ['Retry with downstream', handlers.onRetryWithDownstream],
      ['Re-run this node', handlers.onRerunNode],
      ['Start from this node', handlers.onStartFromNode],
    ] as const) {
      const item = await screen.findByRole('menuitem', { name });
      await user.click(item);
      expect(handler).toHaveBeenCalledOnce();
      await user.click(screen.getByRole('button', { name: 'Run actions for Writer' }));
    }
  });

  it('a retry needs a failed node run; starting from a node never does', async () => {
    const user = userEvent.setup();
    render(
      <NodeRunMenu
        nodeId={NODE}
        nodeName="Writer"
        state="COMPLETED"
        nodeRunId={NODE_RUN}
        {...callbacks()}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Run actions for Writer' }));
    expect(await screen.findByRole('menuitem', { name: 'Retry' })).toHaveAttribute('data-disabled');
    expect(screen.getByRole('menuitem', { name: 'Re-run this node' })).not.toHaveAttribute(
      'data-disabled',
    );
    expect(screen.getByRole('menuitem', { name: 'Start from this node' })).not.toHaveAttribute(
      'data-disabled',
    );
  });
});

describe('V2 control pill: icon-only buttons keep their names', () => {
  it('reaches every action by its accessible name, and Stop is danger-coloured only when allowed', () => {
    const { rerender } = render(
      <RunControls
        runId={RUN}
        status="RUNNING"
        allowedActions={['pause', 'stop']}
        onAction={vi.fn()}
      />,
    );
    for (const name of ['Pause', 'Resume', 'Stop', 'Restart']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: 'Stop' })).toHaveClass('text-danger');
    rerender(
      <RunControls runId={RUN} status="PAUSED" allowedActions={['resume']} onAction={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: 'Stop' })).not.toHaveClass('text-danger');
  });

  it('shows no halt note when showHalt is false', () => {
    render(
      <RunControls
        runId={RUN}
        status="HALTED"
        allowedActions={['restart']}
        haltReason="stopped"
        showHalt={false}
        onAction={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('halt-reason')).toBeNull();
  });
});
