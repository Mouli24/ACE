import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { PALETTE_DRAG_TYPE, Palette } from './Palette';

describe('Palette (FR-NODE-001, FR-CAN-002)', () => {
  it('lists the six round-1 kinds and adds on click or Enter', async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    render(<Palette workflowId="wf" onAdd={onAdd} />);
    for (const kind of ['input', 'agent', 'model', 'output', 'merge', 'transform']) {
      expect(screen.getByTestId(`palette-${kind}`)).toBeInTheDocument();
    }
    await user.click(screen.getByTestId('palette-agent'));
    expect(onAdd).toHaveBeenLastCalledWith('agent');
    screen.getByTestId('palette-merge').focus();
    await user.keyboard('{Enter}');
    expect(onAdd).toHaveBeenLastCalledWith('merge');
  });

  it('puts the kind on the drag payload', () => {
    render(<Palette workflowId="wf" />);
    const data: Record<string, string> = {};
    fireEvent.dragStart(screen.getByTestId('palette-output'), {
      dataTransfer: { setData: (k: string, v: string) => (data[k] = v), effectAllowed: '' },
    });
    expect(data[PALETTE_DRAG_TYPE]).toBe('output');
  });
});
