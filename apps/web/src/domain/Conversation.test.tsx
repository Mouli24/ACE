import type { DomainMessage } from '@ace/contracts';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Conversation } from './Conversation';

/* A node with no handle (an Input, an Output, a merge) is named by its name, never its id. */

const RUN = '01ARZ3NDEKTSV4RRFFQ69G5FB0';
const INPUT = '01ARZ3NDEKTSV4RRFFQ69G5N09';
const AGENT = '01ARZ3NDEKTSV4RRFFQ69G5N01';
const ENV = '01ARZ3NDEKTSV4RRFFQ69G5E01';
const NOW = '2026-10-10T00:00:00.000Z';

const messages: DomainMessage[] = [
  {
    id: 'turn:1',
    runId: RUN,
    cursor: '3.0',
    author: { kind: 'node', nodeId: INPUT },
    type: 'agent',
    text: 'Write Python code for two sum.',
    at: NOW,
  },
  {
    id: `env:${ENV}`,
    runId: RUN,
    cursor: '4.0',
    author: { kind: 'node', nodeId: INPUT },
    type: 'envelope',
    text: 'Write Python code for two sum.',
    to: [AGENT],
    envelope: { id: ENV, kind: 'HANDOFF', from: INPUT, history: [] },
    at: NOW,
  },
];

describe('Domain conversation names', () => {
  it('names a node with no handle by its name, in the header and on an envelope', () => {
    render(
      <Conversation
        messages={messages}
        roster={[{ nodeId: AGENT, handle: 'agent', name: 'Agent', kind: 'agent', brain: false }]}
        names={new Map([[INPUT, 'Brief']])}
        tokens={{}}
        readOnly
        onRoute={vi.fn()}
      />,
    );
    expect(screen.queryByText(new RegExp(INPUT))).not.toBeInTheDocument();
    expect(screen.getAllByText('Brief').length).toBeGreaterThan(0);
    expect(screen.getByText('Brief → @agent')).toBeInTheDocument();
  });
});
