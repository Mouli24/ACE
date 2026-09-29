import type { Message } from '@ace/contracts';
import { render, screen } from '@testing-library/react';

import { TimelineList, type TimelineRow } from './TimelineList';

const WF = 'wf-1';

const row = (id: string, type: Message['type'], extra: Partial<TimelineRow> = {}): TimelineRow => ({
  message: {
    id,
    workflowId: WF,
    type,
    content: [{ type: 'text', text: `${type} body` }],
    at: '2026-09-29T10:00:00.000Z',
  },
  ...extra,
});

describe('TimelineList (FR-CHAT-001 — six distinct styles)', () => {
  it('renders one bubble per message, each carrying its own type', () => {
    const rows: TimelineRow[] = [
      row('m-user', 'user'),
      row('m-agent', 'agent', { nodeName: 'Writer', provider: 'anthropic' }),
      row('m-output', 'output'),
      row('m-event', 'event'),
      row('m-error', 'error'),
      row('m-system', 'system'),
    ];

    render(<TimelineList rows={rows} />);

    const bubbles = screen.getAllByTestId('message-bubble');
    expect(bubbles).toHaveLength(6);
    // MessageBubble stamps its style onto data-type; six present means six distinct styles.
    expect(bubbles.map((b) => b.getAttribute('data-type')).sort()).toEqual(
      ['agent', 'error', 'event', 'output', 'system', 'user'].sort(),
    );
    // The agent bubble reads under its node name.
    expect(screen.getByText('Writer')).toBeInTheDocument();
  });

  it('exposes node and run ids on the row for filtering assertions', () => {
    render(
      <TimelineList
        rows={[
          {
            message: {
              id: 'm1',
              workflowId: WF,
              runId: 'run-a',
              nodeId: 'node-a',
              type: 'agent',
              content: [{ type: 'text', text: 'hi' }],
              at: '2026-09-29T10:00:00.000Z',
            },
          },
        ]}
      />,
    );
    const li = screen.getByTestId('timeline-message-m1');
    expect(li).toHaveAttribute('data-node-id', 'node-a');
    expect(li).toHaveAttribute('data-run-id', 'run-a');
  });

  it('shows the empty label when there are no rows', () => {
    render(<TimelineList rows={[]} emptyLabel="nothing here" />);
    expect(screen.getByTestId('timeline-empty')).toHaveTextContent('nothing here');
  });
});
