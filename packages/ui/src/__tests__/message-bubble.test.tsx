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

  it('gives each of the six types its own look (D328 theme tokens)', () => {
    const looks = new Set<string>();
    for (const type of MESSAGE_TYPES) {
      const { unmount } = render(<MessageBubble type={type} content={text} />);
      looks.add(screen.getByTestId('message-bubble').className);
      unmount();
    }
    expect(looks.size).toBe(MESSAGE_TYPES.length);
  });

  it('user messages are a surface card on the right', () => {
    const { container } = render(<MessageBubble type="user" content={text} />);
    expect(container.firstElementChild?.className).toContain('justify-end');
    const bubble = screen.getByTestId('message-bubble');
    expect(bubble).toHaveClass('bg-[var(--surface)]', 'border-[var(--line)]', 'rounded-[12px]');
  });

  it('agent messages sit on the left under the node name, with the provider dot by default', () => {
    const { container } = render(
      <MessageBubble type="agent" content={text} nodeName="Writer" provider="anthropic" />,
    );
    expect(container.firstElementChild?.className).toContain('items-start');
    expect(screen.getByText('Writer')).toBeInTheDocument();
    expect(screen.getByTestId('message-agent-dot').getAttribute('style') ?? '').toContain(
      '--color-provider-anthropic',
    );
    const bubble = screen.getByTestId('message-bubble');
    expect(bubble).toHaveClass('bg-[var(--soft)]', 'rounded-[12px]');
  });

  it("an agent's own colour wins over its provider's", () => {
    render(
      <MessageBubble
        type="agent"
        content={text}
        nodeName="Writer"
        provider="anthropic"
        color="#7a62d6"
      />,
    );
    expect(screen.getByTestId('message-agent-dot')).toHaveStyle({ background: '#7a62d6' });
  });

  it('output is the green output card, labelled as the final output', () => {
    render(<MessageBubble type="output" content={text} />);
    const bubble = screen.getByTestId('message-bubble');
    expect(bubble).toHaveClass('border-[rgba(47,158,99,0.35)]');
    expect(screen.getByText(/final output/i)).toBeInTheDocument();
  });

  it('event and system are muted lines, system italic, not cards', () => {
    const { rerender } = render(<MessageBubble type="event" content={text} />);
    const event = screen.getByTestId('message-bubble');
    expect(event).toHaveClass('text-[var(--muted)]');
    expect(event.className).not.toMatch(/rounded|border/);
    rerender(<MessageBubble type="system" content={text} />);
    expect(screen.getByTestId('message-bubble')).toHaveClass('italic');
  });

  it('error is a red alert card', () => {
    render(<MessageBubble type="error" content={[{ type: 'text', text: 'it broke' }]} />);
    const bubble = screen.getByTestId('message-bubble');
    expect(bubble).toHaveAttribute('role', 'alert');
    expect(bubble).toHaveClass('border-[rgba(201,76,39,0.35)]');
  });

  it('renders each part type through PartRenderer, and shows a meta line', () => {
    const content: Part[] = [
      { type: 'text', text: 'see file' },
      {
        type: 'file',
        artifactId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        mime: 'application/zip',
        name: 'a.zip',
        size: 4,
      },
    ];
    render(
      <MessageBubble
        type="agent"
        content={content}
        contentUrl={(id) => `/c/${id}`}
        meta={<span>12:00 · 30 tokens</span>}
      />,
    );
    expect(screen.getByTestId('file-card')).toHaveAttribute(
      'href',
      '/c/01ARZ3NDEKTSV4RRFFQ69G5FAV',
    );
    expect(screen.getByText(/30 tokens/)).toBeInTheDocument();
  });
});
