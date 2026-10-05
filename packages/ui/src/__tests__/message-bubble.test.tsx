import { MESSAGE_TYPES, type Part } from '@ace/contracts';
import { render, screen } from '@testing-library/react';

import { MessageBubble } from '../components/message-bubble.js';

const text: Part[] = [{ type: 'text', text: 'hello there' }];

describe('FR-CHAT-001 the six message types read differently on sight', () => {
  it('renders every MessageType with its own data-type and its content', () => {
    for (const type of MESSAGE_TYPES) {
      const { unmount } = render(<MessageBubble type={type} content={text} />);
      const bubble = screen.getByTestId('message-bubble');
      expect(bubble).toHaveAttribute('data-type', type);
      expect(bubble).toHaveTextContent('hello there');
      unmount();
    }
  });

  it('user messages are right-aligned', () => {
    const { container } = render(<MessageBubble type="user" content={text} />);
    expect(container.firstElementChild?.className).toContain('justify-end');
  });

  it('agent messages show the node name and carry the provider accent on the edge', () => {
    render(<MessageBubble type="agent" content={text} nodeName="Writer" provider="anthropic" />);
    expect(screen.getByText('Writer')).toBeInTheDocument();
    const bubble = screen.getByTestId('message-bubble');
    expect(bubble.getAttribute('style') ?? '').toContain('--color-provider-anthropic');
    expect(bubble.className).toContain('rounded-[14px_14px_14px_4px]');
    expect(bubble.className).toContain('text-fg-soft');
  });

  it('user bubbles use the chat shape', () => {
    render(<MessageBubble type="user" content={text} />);
    const bubble = screen.getByTestId('message-bubble');
    expect(bubble.className).toContain('rounded-[14px_14px_4px_14px]');
    expect(bubble.className).toContain('border-border-strong');
  });

  it('output is highlighted and labelled as the final output', () => {
    render(<MessageBubble type="output" content={text} />);
    const bubble = screen.getByTestId('message-bubble');
    expect(bubble.className).toContain('border-accent/60');
    expect(screen.getByText(/final output/i)).toBeInTheDocument();
  });

  it('event and system are muted lines, system italic, not cards', () => {
    const { rerender } = render(<MessageBubble type="event" content={text} />);
    expect(screen.getByTestId('message-bubble').className).toContain('text-fg-muted');
    rerender(<MessageBubble type="system" content={text} />);
    expect(screen.getByTestId('message-bubble').className).toContain('italic');
  });

  it('error is a red alert card', () => {
    render(<MessageBubble type="error" content={[{ type: 'text', text: 'it broke' }]} />);
    const bubble = screen.getByTestId('message-bubble');
    expect(bubble).toHaveAttribute('role', 'alert');
    expect(bubble.className).toContain('border-danger/60');
  });

  it('renders each part type through PartRenderer, and shows a meta line', () => {
    const content: Part[] = [
      { type: 'text', text: 'see file' },
      { type: 'file', artifactId: '01ARZ3NDEKTSV4RRFFQ69G5FAV', mime: 'application/zip', name: 'a.zip', size: 4 },
    ];
    render(
      <MessageBubble
        type="agent"
        content={content}
        contentUrl={(id) => `/c/${id}`}
        meta={<span>12:00 · 30 tokens</span>}
      />,
    );
    expect(screen.getByTestId('file-card')).toHaveAttribute('href', '/c/01ARZ3NDEKTSV4RRFFQ69G5FAV');
    expect(screen.getByText(/30 tokens/)).toBeInTheDocument();
  });
});
