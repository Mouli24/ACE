import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { TimelineComposer } from './TimelineComposer';

describe('TimelineComposer (FR-CHAT-003)', () => {
  it('sends the trimmed text and clears the box', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn<(text: string) => void>();
    render(<TimelineComposer onSend={onSend} />);

    const box = screen.getByLabelText('Message to send to the workflow');
    await user.type(box, '  hello  ');
    await user.click(screen.getByTestId('timeline-send'));

    expect(onSend).toHaveBeenCalledWith('hello');
    expect(box).toHaveValue('');
  });

  it('sends on Enter and adds a newline on Shift+Enter (keyboard-only)', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn<(text: string) => void>();
    render(<TimelineComposer onSend={onSend} />);

    const box = screen.getByLabelText('Message to send to the workflow');
    await user.click(box);
    await user.keyboard('one{Shift>}{Enter}{/Shift}two');
    expect(onSend).not.toHaveBeenCalled();
    expect(box).toHaveValue('one\ntwo');

    await user.keyboard('{Enter}');
    expect(onSend).toHaveBeenCalledWith('one\ntwo');
  });

  it('never sends an empty or whitespace-only message', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn<(text: string) => void>();
    render(<TimelineComposer onSend={onSend} />);

    expect(screen.getByTestId('timeline-send')).toBeDisabled();
    await user.type(screen.getByLabelText('Message to send to the workflow'), '   ');
    expect(screen.getByTestId('timeline-send')).toBeDisabled();
    await user.keyboard('{Enter}');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('is the theme composer: the ↑ send keeps the name "Send to workflow" (D328)', async () => {
    const user = userEvent.setup();
    render(<TimelineComposer onSend={vi.fn()} />);
    const send = screen.getByRole('button', { name: 'Send to workflow' });
    expect(send).toBe(screen.getByTestId('timeline-send'));
    expect(send).toHaveTextContent('↑');
    expect(send.style.background).toBe('var(--sendOff)');
    await user.type(screen.getByLabelText('Message to send to the workflow'), 'hi');
    expect(send.style.background).toBe('rgb(239, 107, 63)');
  });

  it('disables while a send is in flight', () => {
    render(<TimelineComposer onSend={vi.fn()} busy />);
    expect(screen.getByLabelText('Message to send to the workflow')).toBeDisabled();
    expect(screen.getByTestId('timeline-send')).toBeDisabled();
  });
});
