import { GUARDRAIL_ACTIONS, type ApprovalRequest, type Verdict } from '@ace/contracts';
import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';

import {
  ApprovalCard,
  GUARDRAIL_ACTION_LABEL,
  guardrailActionLabels,
} from '../components/approval-card.js';
import { VerdictBadge } from '../components/verdict-badge.js';

const ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const NOW = '2026-09-26T00:00:00.000Z';

const request = (overrides: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  id: ID,
  runId: ID,
  nodeRunId: ID,
  nodeId: ID,
  nodeName: 'Writer',
  point: 'output',
  checkType: 'pii',
  reason: 'The output looks like it contains an email address.',
  preview: 'Contact me at a@b.example for the details.',
  requestedAt: NOW,
  ...overrides,
});

const verdict = (overrides: Partial<Verdict> = {}): Verdict => ({
  id: ID,
  nodeRunId: ID,
  point: 'output',
  checkType: 'pii',
  action: 'redact',
  passed: true,
  reason: 'one email address removed',
  at: NOW,
  ...overrides,
});

describe('TC-GRD-008/009 the approval card asks, and answers on the keyboard', () => {
  it('shows the node, the check, the reason and the engine’s preview', () => {
    render(
      <ApprovalCard request={request()} onApprove={() => undefined} onReject={() => undefined} />,
    );

    expect(screen.getByTestId(`approval-card-${ID}`)).toHaveAttribute('data-point', 'output');
    expect(screen.getByText('Writer')).toBeInTheDocument();
    expect(screen.getByTestId('approval-reason')).toHaveTextContent(/email address/);
    expect(screen.getByTestId('approval-preview')).toHaveTextContent('a@b.example');
    expect(screen.getByRole('button', { name: /approve/i })).toBeEnabled();
  });

  it('approves on A and rejects on R, and never while the note has focus', async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn();
    const onReject = vi.fn();
    render(<ApprovalCard request={request()} onApprove={onApprove} onReject={onReject} />);

    await user.keyboard('a');
    expect(onApprove).toHaveBeenCalledTimes(1);
    await user.keyboard('r');
    expect(onReject).toHaveBeenCalledTimes(1);

    // Typing a note must not decide anything — the letters belong to the text field.
    await user.click(screen.getByLabelText('Decision note'));
    await user.keyboard('are we sure');
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onReject).toHaveBeenCalledTimes(1);
  });

  it('reports the decision instead of asking again, and takes no more keys', async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn();
    render(
      <ApprovalCard
        request={request()}
        decided="approve"
        onApprove={onApprove}
        onReject={() => undefined}
      />,
    );

    expect(screen.getByTestId('approval-decision')).toHaveAttribute('data-decision', 'approve');
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
    await user.keyboard('a');
    expect(onApprove).not.toHaveBeenCalled();
  });

  it('disables both buttons while a decision is in flight', () => {
    render(
      <ApprovalCard
        request={request()}
        pending
        onApprove={() => undefined}
        onReject={() => undefined}
      />,
    );
    expect(screen.getByRole('button', { name: /approve/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /reject/i })).toBeDisabled();
  });
});

describe('TC-GRD-016/018/019 verdicts read as actions, and a redaction shows types only', () => {
  it('labels every guardrail action, with "ask user" for ask_user', () => {
    expect(guardrailActionLabels().map((option) => option.value)).toEqual([...GUARDRAIL_ACTIONS]);
    expect(GUARDRAIL_ACTION_LABEL.ask_user).toBe('ask user');
    for (const action of GUARDRAIL_ACTIONS) {
      expect(GUARDRAIL_ACTION_LABEL[action]).toBeTruthy();
    }
  });

  it('gives each action its own glyph and colour, not hue alone', () => {
    const glyphs = new Set<string>();
    const colours = new Set<string>();
    for (const action of GUARDRAIL_ACTIONS) {
      const { unmount } = render(<VerdictBadge verdict={verdict({ action })} />);
      const badge = screen.getByTestId(`verdict-${ID}`);
      expect(badge).toHaveAttribute('data-action', action);
      const glyph = badge.querySelector('[data-glyph]');
      glyphs.add(glyph?.textContent ?? '');
      colours.add(glyph?.getAttribute('style') ?? '');
      unmount();
    }
    expect(glyphs.size).toBe(GUARDRAIL_ACTIONS.length);
    expect(colours.size).toBe(GUARDRAIL_ACTIONS.length);
  });

  it('shows the types a redaction removed and nothing that could be the value', () => {
    render(<VerdictBadge verdict={verdict({ redactedTypes: ['email', 'phone'] })} />);

    const badge = screen.getByTestId(`verdict-${ID}`);
    expect(screen.getByTestId(`verdict-redacted-${ID}`)).toHaveTextContent('removed email, phone');
    // FR-GRD-014: the contract has no field for the value, and this renders none either.
    expect(badge.textContent).not.toContain('a@b.example');
  });
});
