import { PERSISTED_RUN_EVENT_TYPES, zeroUsage } from '@ace/contracts';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { EventsTab, describeEvent, type RunEventEntry } from './EventsTab';

const RUN = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const WF = '01BRZ3NDEKTSV4RRFFQ69G5FAV';
const WRITER = '01CRZ3NDEKTSV4RRFFQ69G5FAV';
const REVIEWER = '01DRZ3NDEKTSV4RRFFQ69G5FAV';
const WRITER_RUN = '01ERZ3NDEKTSV4RRFFQ69G5FAV';
const REVIEWER_RUN = '01FRZ3NDEKTSV4RRFFQ69G5FAV';
const EDGE = '01GRZ3NDEKTSV4RRFFQ69G5FAV';
const REQUEST = '01HRZ3NDEKTSV4RRFFQ69G5FAV';
const VERDICT = '01JRZ3NDEKTSV4RRFFQ69G5FAV';
const TOOL_CALL = '01KRZ3NDEKTSV4RRFFQ69G5FAV';
const MESSAGE = '01MRZ3NDEKTSV4RRFFQ69G5FAV';

const NODES = [
  { id: WRITER, name: 'Writer' },
  { id: REVIEWER, name: 'Reviewer' },
];

const AT = '2026-09-26T10:00:00.000Z';

/**
 * One entry per persisted event type of §2.4 and §2.6 — the `PERSISTED_RUN_EVENT_TYPES` assertion
 * below is what keeps this list honest, so a type added to the contract cannot render a blank row.
 */
const ENTRIES: RunEventEntry[] = [
  {
    event: {
      type: 'run.started',
      seq: 1,
      payload: {
        run: { id: RUN, workflowId: WF, status: 'RUNNING', startedAt: AT, totals: zeroUsage() },
      },
    },
  },
  {
    event: {
      type: 'node.state',
      seq: 2,
      payload: {
        runId: RUN,
        nodeRunId: WRITER_RUN,
        nodeId: WRITER,
        iteration: 1,
        attempt: 1,
        status: 'RUNNING',
      },
    },
  },
  {
    event: {
      type: 'node.output',
      seq: 3,
      payload: {
        runId: RUN,
        nodeRunId: WRITER_RUN,
        nodeId: WRITER,
        output: [{ type: 'text', text: 'a draft' }],
        usage: { tokensIn: 10, tokensOut: 20, costUsd: 0.001 },
      },
    },
  },
  {
    event: {
      type: 'guardrail.verdict',
      seq: 4,
      payload: {
        runId: RUN,
        nodeRunId: WRITER_RUN,
        verdict: {
          id: VERDICT,
          nodeRunId: WRITER_RUN,
          point: 'output',
          checkType: 'pii',
          action: 'redact',
          passed: false,
          reason: 'an address was found',
          redactedTypes: ['email'],
          at: AT,
        },
      },
    },
  },
  {
    event: {
      type: 'edge.transfer',
      seq: 5,
      payload: {
        runId: RUN,
        edgeId: EDGE,
        fromNodeId: WRITER,
        toNodeId: REVIEWER,
        iteration: 1,
        summary: 'text · 1 part',
      },
    },
  },
  {
    event: {
      type: 'node.approval_required',
      seq: 6,
      payload: {
        runId: RUN,
        request: {
          id: REQUEST,
          runId: RUN,
          nodeRunId: REVIEWER_RUN,
          nodeId: REVIEWER,
          nodeName: 'Reviewer',
          point: 'output',
          checkType: 'pii',
          reason: 'an email address is in the output',
          preview: 'contact me at …',
          requestedAt: AT,
        },
      },
    },
  },
  {
    event: {
      type: 'node.approval_decided',
      seq: 7,
      payload: {
        runId: RUN,
        nodeRunId: REVIEWER_RUN,
        decision: { requestId: REQUEST, decision: 'approve', note: 'fine', decidedAt: AT },
      },
    },
  },
  { event: { type: 'run.paused', seq: 8, payload: { runId: RUN } } },
  { event: { type: 'run.resumed', seq: 9, payload: { runId: RUN } } },
  {
    event: {
      type: 'loop.iteration',
      seq: 10,
      payload: { runId: RUN, edgeId: EDGE, targetNodeId: WRITER, iteration: 2 },
    },
  },
  {
    event: {
      type: 'loop.iteration',
      seq: 11,
      payload: {
        runId: RUN,
        edgeId: EDGE,
        targetNodeId: WRITER,
        iteration: 3,
        stop: 'max_iterations',
      },
    },
  },
  {
    event: {
      type: 'node.error',
      seq: 12,
      payload: {
        runId: RUN,
        nodeRunId: REVIEWER_RUN,
        nodeId: REVIEWER,
        error: {
          kind: 'provider',
          code: 'provider_503',
          message: 'Service Unavailable',
          retryable: true,
        },
        failureReason: 'RUN_FAILED',
      },
    },
  },
  {
    event: {
      type: 'usage.updated',
      seq: 13,
      payload: { runId: RUN, totals: { tokensIn: 10, tokensOut: 20, costUsd: 0.0123 } },
    },
  },
  {
    event: {
      type: 'run.completed',
      seq: 14,
      payload: {
        runId: RUN,
        status: 'HALTED',
        haltReason: 'budget_exceeded',
        totals: { tokensIn: 10, tokensOut: 20, costUsd: 0.0123 },
        budgetHalt: { scope: 'run', capUsd: 0.01, costUsd: 0.012, projected: false },
      },
    },
    at: AT,
  },
  // Round 4's two run events (§2.4). They are listed after the halt only because this list is one
  // entry per type, not a story; the M4 renderers get their own tests.
  {
    event: {
      type: 'tool.call',
      seq: 15,
      payload: {
        runId: RUN,
        nodeRunId: WRITER_RUN,
        toolCall: {
          id: TOOL_CALL,
          nodeRunId: WRITER_RUN,
          toolName: 'web_search',
          args: { query: 'draft sources' },
          resultSummary: '3 results',
          durationMs: 412,
          status: 'ok',
          verdicts: [],
          at: AT,
        },
      },
    },
  },
  {
    event: {
      type: 'message.created',
      seq: 16,
      payload: {
        workflowId: WF,
        // A user message posted to the timeline names no node and no run.
        message: {
          id: MESSAGE,
          workflowId: WF,
          type: 'user',
          content: [{ type: 'text', text: 'looks good' }],
          at: AT,
        },
      },
    },
  },
];

describe('Events tab — the run, in order (round 3 §5 item 7, NFR-OBS-01)', () => {
  it('covers every persisted event type the contract declares', () => {
    expect(new Set(ENTRIES.map((entry) => entry.event.type))).toEqual(
      new Set(PERSISTED_RUN_EVENT_TYPES),
    );
    // Every one of them words itself; none renders an empty row.
    for (const { event } of ENTRIES) {
      expect(describeEvent(event, () => 'Writer').trim().length).toBeGreaterThan(3);
    }
  });

  it('lists state changes, verdicts, approvals, loop iterations and the halt, in seq order', () => {
    // Deliberately shuffled: seq is the order things happened, not the order they arrived.
    render(<EventsTab entries={[...ENTRIES].reverse()} nodes={NODES} />);

    const rows = within(screen.getByTestId('events-list')).getAllByRole('listitem');
    expect(rows.map((row) => row.getAttribute('data-type'))).toEqual(
      ENTRIES.map((entry) => entry.event.type),
    );

    expect(screen.getByTestId('event-2')).toHaveTextContent('Writer → running');
    expect(screen.getByTestId('event-5')).toHaveTextContent('Writer → Reviewer: text · 1 part');
    expect(screen.getByTestId('event-6')).toHaveTextContent('Reviewer is waiting for you');
    expect(screen.getByTestId('event-7')).toHaveTextContent('approval approved — fine');
    expect(screen.getByTestId('event-8')).toHaveTextContent('run paused');
    expect(screen.getByTestId('event-10')).toHaveTextContent('loop iteration 2 of Writer');
    expect(screen.getByTestId('event-11')).toHaveTextContent(
      'loop stopped after iteration 3 of Writer — it reached the maximum iterations',
    );
    expect(screen.getByTestId('event-12')).toHaveTextContent('Reviewer failed — provider');
    expect(screen.getByTestId('event-13')).toHaveTextContent('run cost so far $0.0123');
    expect(screen.getByTestId('event-15')).toHaveTextContent('web_search ok in 412 ms — 3 results');
    expect(screen.getByTestId('event-16')).toHaveTextContent('user added a user message');
    // The halt reads in the same words as the run bar's (FR-GRD-008, NFR-USE-03).
    expect(screen.getByTestId('event-14')).toHaveTextContent(
      'run halted — budget exceeded: $0.012 > $0.01 cap',
    );
  });

  it('shows a redaction as the type only, never a value (FR-GRD-014)', () => {
    render(<EventsTab entries={ENTRIES} nodes={NODES} />);
    const row = screen.getByTestId('event-4');
    expect(row).toHaveTextContent('pii at output — redact, not passed');
    expect(row).toHaveTextContent('redacted: email');
  });

  it('uses the contract label "ask user" where a verdict asked (CLAUDE.md §7)', () => {
    render(
      <EventsTab
        nodes={NODES}
        entries={[
          {
            event: {
              type: 'guardrail.verdict',
              seq: 1,
              payload: {
                runId: RUN,
                nodeRunId: WRITER_RUN,
                verdict: {
                  id: VERDICT,
                  nodeRunId: WRITER_RUN,
                  point: 'tool',
                  checkType: 'destructive_action',
                  action: 'ask_user',
                  passed: false,
                  reason: 'it would delete a folder',
                  at: AT,
                },
              },
            },
          },
        ]}
      />,
    );
    expect(screen.getByTestId('event-1')).toHaveTextContent('ask user');
    expect(screen.getByTestId('event-1')).not.toHaveTextContent('ask_user');
  });

  it('filters by node, and keeps a node-run-only event with the node it belongs to', async () => {
    const user = userEvent.setup();
    render(<EventsTab entries={ENTRIES} nodes={NODES} />);

    await user.click(screen.getByLabelText('Filter by node'));
    await user.click(await screen.findByRole('option', { name: 'Reviewer' }));

    // The Reviewer's own events: the transfer into it, its approval request and decision, its error.
    const types = within(screen.getByTestId('events-list'))
      .getAllByRole('listitem')
      .map((row) => row.getAttribute('data-type'));
    expect(types).toEqual([
      'edge.transfer',
      'node.approval_required',
      'node.approval_decided',
      'node.error',
    ]);
    // The Writer's state change is not the Reviewer's business, and neither is the run's own halt,
    // the Writer's tool call, or a timeline message that names no node.
    expect(screen.queryByTestId('event-2')).not.toBeInTheDocument();
    expect(screen.queryByTestId('event-14')).not.toBeInTheDocument();
    expect(screen.queryByTestId('event-15')).not.toBeInTheDocument();
    expect(screen.queryByTestId('event-16')).not.toBeInTheDocument();
    expect(screen.getByTestId('events-count')).toHaveTextContent('4 events');
  });

  it('can point at the node a row is about', async () => {
    const user = userEvent.setup();
    const onShowNode = vi.fn();
    render(
      <EventsTab entries={[ENTRIES[1] as RunEventEntry]} nodes={NODES} onShowNode={onShowNode} />,
    );
    await user.click(screen.getByRole('button', { name: 'show node' }));
    expect(onShowNode).toHaveBeenCalledExactlyOnceWith(WRITER);
  });

  it('says there is nothing yet before a run starts', () => {
    render(<EventsTab entries={[]} nodes={NODES} />);
    expect(screen.getByTestId('events-tab')).toHaveTextContent('No events yet');
  });
});
