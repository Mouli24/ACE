import type { ApprovalDecision, ToolCall, ToolCallStatus, Verdict } from '@ace/contracts';
import { render, screen, within } from '@testing-library/react';

import { ToolCallsTab } from './ToolCallsTab';

/**
 * The inspector's "Tool calls" tab (FR-TOOL-009, TC-TOOL-010): every call's name, args as
 * delivered (already redacted), result summary, duration, status and verdicts, plus the linked
 * approval decision on a destructive call.
 */

const at = '2026-09-29T10:00:00.000Z';

function verdict(over: Partial<Verdict> = {}): Verdict {
  return {
    id: `V${Math.random().toString(36).slice(2, 10)}`,
    nodeRunId: 'NR1',
    point: 'tool',
    checkType: 'tool_allowed',
    action: 'pass',
    passed: true,
    reason: 'echo is enabled for this agent.',
    at,
    ...over,
  };
}

let seq = 0;
function call(over: Partial<ToolCall> = {}): ToolCall {
  seq += 1;
  return {
    id: `TC${seq}`,
    nodeRunId: 'NR1',
    toolName: 'echo',
    args: { text: 'hello' },
    resultSummary: 'echo → hello',
    durationMs: 12,
    status: 'ok',
    verdicts: [],
    at,
    ...over,
  };
}

describe('TC-TOOL-010 the tool calls tab lists what each call did', () => {
  it('empty state when nothing was called', () => {
    render(<ToolCallsTab toolCalls={[]} />);
    expect(screen.getByTestId('tool-calls-empty')).toBeInTheDocument();
  });

  it('shows name, args, result, duration and verdicts for a call', () => {
    const c = call({
      toolName: 'http_request',
      args: { url: 'https://example.com', apiKey: '••••redacted••••' },
      resultSummary: '200 OK · 1.2 KB',
      durationMs: 340,
      verdicts: [verdict({ checkType: 'domain_allowlist' })],
    });
    render(<ToolCallsTab toolCalls={[c]} />);

    const row = screen.getByTestId(`tool-call-${c.id}`);
    expect(within(row).getByTestId(`tool-call-name-${c.id}`)).toHaveTextContent('http_request');
    expect(within(row).getByTestId(`tool-call-duration-${c.id}`)).toHaveTextContent('340 ms');
    expect(within(row).getByTestId(`tool-call-result-${c.id}`)).toHaveTextContent('200 OK · 1.2 KB');
    // Args are shown exactly as delivered — the redaction already happened engine-side (BR-07).
    const args = within(row).getByTestId(`tool-call-args-${c.id}`);
    expect(args).toHaveTextContent('https://example.com');
    expect(args).toHaveTextContent('••••redacted••••');
    // The verdict the tool point recorded is on the call.
    expect(within(row).getByTestId(`tool-call-verdicts-${c.id}`)).toHaveTextContent(
      'domain_allowlist',
    );
  });

  it('renders every one of the five statuses distinctly', () => {
    const statuses: ToolCallStatus[] = ['ok', 'error', 'blocked', 'rejected', 'timeout'];
    const calls = statuses.map((status) => call({ status }));
    render(<ToolCallsTab toolCalls={calls} />);

    for (const c of calls) {
      const badge = screen.getByTestId(`tool-call-status-${c.id}`);
      expect(badge).toHaveAttribute('data-status', c.status);
      expect(badge).toHaveTextContent(c.status);
      expect(screen.getByTestId(`tool-call-${c.id}`)).toHaveAttribute('data-status', c.status);
    }
  });

  it('links the approval decision to the destructive call that asked for it', () => {
    const asked = verdict({
      checkType: 'destructive_action',
      action: 'ask_user',
      passed: false,
      reason: 'sandbox_delete is destructive and needs approval.',
    });
    const destructive = call({
      toolName: 'sandbox_delete',
      args: { path: 'notes.txt' },
      resultSummary: 'deleted notes.txt',
      verdicts: [asked],
    });
    const plain = call({ toolName: 'echo', verdicts: [verdict()] });
    const decision: ApprovalDecision = {
      requestId: 'REQ1',
      decision: 'approve',
      note: 'safe to remove',
      decidedAt: at,
    };

    render(<ToolCallsTab toolCalls={[plain, destructive]} approvals={[decision]} />);

    // The plain call never asked, so it carries no decision.
    expect(screen.queryByTestId(`tool-call-approval-${plain.id}`)).not.toBeInTheDocument();

    const linked = screen.getByTestId(`tool-call-approval-${destructive.id}`);
    expect(linked).toHaveAttribute('data-decision', 'approve');
    expect(linked).toHaveTextContent('approved');
    expect(linked).toHaveTextContent('safe to remove');
  });

  it('shows a rejected destructive call with its rejection', () => {
    const asked = verdict({
      checkType: 'destructive_action',
      action: 'ask_user',
      passed: false,
      reason: 'needs approval',
    });
    const destructive = call({ toolName: 'sandbox_delete', status: 'rejected', verdicts: [asked] });
    const decision: ApprovalDecision = {
      requestId: 'REQ2',
      decision: 'reject',
      decidedAt: at,
    };
    render(<ToolCallsTab toolCalls={[destructive]} approvals={[decision]} />);
    const linked = screen.getByTestId(`tool-call-approval-${destructive.id}`);
    expect(linked).toHaveAttribute('data-decision', 'reject');
    expect(linked).toHaveTextContent('rejected');
  });
});
