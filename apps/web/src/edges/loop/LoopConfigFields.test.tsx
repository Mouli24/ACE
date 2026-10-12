import type { LoopConfig } from '@ace/contracts';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { LoopConfigFields } from './LoopConfigFields';

const config: LoopConfig = {
  maxIterations: 3,
  exitCondition: { path: 'verdict', equals: 'approved' },
  onMax: 'continue',
};

function setup(value: LoopConfig = config) {
  const onCommit = vi.fn();
  render(<LoopConfigFields value={value} onCommit={onCommit} />);
  return { onCommit, user: userEvent.setup(), max: screen.getByLabelText(/max iterations/i) };
}

describe('TC-CON-007 Loop limits', () => {
  it.each(['0', '51'])('refuses max iterations %s inline and saves nothing', async (value) => {
    const { onCommit, user, max } = setup();
    await user.clear(max);
    await user.type(max, value);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Max iterations must be a whole number from 1 to 50.',
    );
    expect(max).toHaveAttribute('aria-invalid', 'true');

    await user.tab();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('refuses both 0 and 51 in one sitting, then saves a number in range', async () => {
    const { onCommit, user, max } = setup();
    await user.clear(max);
    await user.type(max, '0');
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    await user.clear(max);
    await user.type(max, '51');
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(onCommit).not.toHaveBeenCalled();

    await user.clear(max);
    await user.type(max, '50');
    await user.tab();
    expect(onCommit).toHaveBeenCalledWith({ ...config, maxIterations: 50 });
  });

  it('shows the whole config the edge already has', () => {
    setup();
    expect(screen.getByLabelText(/max iterations/i)).toHaveValue(3);
    expect(screen.getByLabelText(/exit when path/i)).toHaveValue('verdict');
    expect(screen.getByLabelText(/^equals$/i)).toHaveValue('approved');
    expect(screen.getByLabelText(/at the maximum/i)).toHaveTextContent(/continue/i);
  });
});

describe('FR-CON-007 loop edge editor', () => {
  it('refuses a path the engine could not read, and saves nothing', async () => {
    const { onCommit, user } = setup();
    const path = screen.getByLabelText(/exit when path/i);
    await user.clear(path);
    await user.type(path, '$.verdict');

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The path must be a dotted path such as verdict or review.issues.0.',
    );
    await user.tab();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('commits a new exit path on blur', async () => {
    const { onCommit, user } = setup();
    const path = screen.getByLabelText(/exit when path/i);
    await user.clear(path);
    await user.type(path, 'review.verdict');
    await user.tab();
    expect(onCommit).toHaveBeenCalledWith({
      ...config,
      exitCondition: { path: 'review.verdict', equals: 'approved' },
    });
  });

  it('says how the exit value is read, and commits it as that', async () => {
    const { onCommit, user } = setup();
    const equals = screen.getByLabelText(/^equals$/i);
    expect(screen.getByText('read as text')).toBeInTheDocument();

    await user.clear(equals);
    await user.type(equals, 'true');
    expect(await screen.findByText('read as true/false')).toBeInTheDocument();
    await user.tab();
    expect(onCommit).toHaveBeenCalledWith({
      ...config,
      exitCondition: { path: 'verdict', equals: true },
    });
  });

  it('commits onMax as soon as it is chosen (FR-CON-007)', async () => {
    const { onCommit, user } = setup();
    await user.click(screen.getByLabelText(/at the maximum/i));
    await user.click(await screen.findByRole('option', { name: /fail the node/i }));
    expect(onCommit).toHaveBeenCalledWith({ ...config, onMax: 'fail' });
  });

  it('saves as it is typed, after a pause, without a blur (D333)', async () => {
    const { onCommit, user } = setup();
    const path = screen.getByLabelText(/exit when path/i);
    await user.clear(path);
    await user.type(path, 'review.verdict');
    expect(path).toHaveFocus();
    await waitFor(() =>
      expect(onCommit).toHaveBeenLastCalledWith({
        ...config,
        exitCondition: { path: 'review.verdict', equals: 'approved' },
      }),
    );
  });

  it('commits a pending edit when it unmounts (the modal closing)', async () => {
    const onCommit = vi.fn();
    const user = userEvent.setup();
    const { unmount } = render(<LoopConfigFields value={config} onCommit={onCommit} />);
    const max = screen.getByLabelText(/max iterations/i);
    await user.clear(max);
    await user.type(max, '7');
    unmount();
    expect(onCommit).toHaveBeenLastCalledWith({ ...config, maxIterations: 7 });
  });

  it('commits nothing when a field is edited back to what it already was', async () => {
    const { onCommit, user, max } = setup();
    await user.clear(max);
    await user.type(max, '3');
    await user.tab();
    expect(onCommit).not.toHaveBeenCalled();
  });
});
