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

  it('in the desktop bar’s narrow band the note folds to a "?" whose title says the same words', () => {
    render(<RunControls runId={RUN} status="RUNNING" onAction={vi.fn()} />);
    const note = screen.getByTestId('run-controls-unknown');
    // visually hidden from 641 px to xl (so it cannot wrap out of the 52 px bar), still read out;
    // the phone header and xl+ show it whole
    expect(note).toHaveClass('min-[641px]:max-xl:sr-only');
    expect(note).toHaveTextContent('the engine did not say which controls this run allows');
    const glyph = screen.getByText('?');
    expect(glyph).toHaveAttribute('aria-hidden', 'true');
    expect(glyph).toHaveClass('hidden', 'min-[641px]:max-xl:inline-grid');
    expect(glyph).toHaveAttribute('title', note.textContent);
    // on the desktop bar the controls never shrink, so nothing in them wraps under the pill;
    // the phone header keeps wrapping, which is how its inline halt note gets a line of its own
    expect(screen.getByTestId('run-controls')).toHaveClass('flex-wrap', 'min-[641px]:shrink-0');
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

  it('[audit W-8] while a run is going, Start from this node waits and says why', async () => {
    const user = userEvent.setup();
    render(
      <NodeRunMenu
        nodeId={NODE}
        nodeName="Writer"
        state="COMPLETED"
        nodeRunId={NODE_RUN}
        runGoing
        {...callbacks()}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Run actions for Writer' }));
    const start = await screen.findByRole('menuitem', { name: 'Start from this node' });
    expect(start).toHaveAttribute('data-disabled');
    expect(start).toHaveAttribute('title', 'A run is going — stop it first');
    // the node's own actions are not a new run
    expect(screen.getByRole('menuitem', { name: 'Re-run this node' })).not.toHaveAttribute(
      'data-disabled',
    );
  });

  describe('D388 a node run cut off before it finished can be retried too', () => {
    const restarted = (code: string) => ({
      kind: 'workflow' as const,
      code,
      message: 'The engine restarted under this step.',
      retryable: false,
    });
    const retryItems = async (props: {
      state: 'STOPPED' | 'BLOCKED';
      error?: ReturnType<typeof restarted>;
    }) => {
      const user = userEvent.setup();
      render(
        <NodeRunMenu
          nodeId={NODE}
          nodeName="Writer"
          nodeRunId={NODE_RUN}
          {...props}
          {...callbacks()}
        />,
      );
      await user.click(screen.getByRole('button', { name: 'Run actions for Writer' }));
      return [
        await screen.findByRole('menuitem', { name: 'Retry' }),
        screen.getByRole('menuitem', { name: 'Retry with downstream' }),
      ];
    };

    it('offers Retry for a STOPPED node run', async () => {
      for (const item of await retryItems({ state: 'STOPPED' })) {
        expect(item).not.toHaveAttribute('data-disabled');
      }
    });

    it.each(['engine_restarted', 'approval_lost'])(
      'offers Retry for a node run left BLOCKED %s',
      async (code) => {
        for (const item of await retryItems({ state: 'BLOCKED', error: restarted(code) })) {
          expect(item).not.toHaveAttribute('data-disabled');
        }
      },
    );

    it('not for one BLOCKED because its upstream failed — it never started', async () => {
      for (const item of await retryItems({ state: 'BLOCKED' })) {
        expect(item).toHaveAttribute('data-disabled');
      }
    });
  });
});

describe('D328 theme pills: every control is a labelled pill', () => {
  it('reaches every action by its visible name, and Stop is danger-coloured only when allowed', () => {
    const { rerender } = render(
      <RunControls
        runId={RUN}
        status="RUNNING"
        allowedActions={['pause', 'stop']}
        onAction={vi.fn()}
      />,
    );
    for (const name of ['Pause', 'Resume', 'Stop', 'Restart', 'End']) {
      const button = screen.getByRole('button', { name });
      expect(button).toHaveTextContent(name);
      expect(button).toHaveClass('rounded-full', 'h-[30px]');
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
