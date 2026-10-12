import type { ApprovalDecision, ToolCall, ToolCallStatus } from '@ace/contracts';

import { VerdictList } from '../guardrails/VerdictList';

/**
 * The inspector's "Tool calls" tab (round 4 §5 item 7, FR-TOOL-009, TC-TOOL-010).
 *
 * Every tool a node run called, in order, with the six facts FR-TOOL-009 records: the name, the
 * arguments *as delivered* (the engine has already redacted key-shaped values, BR-07 — this only
 * renders them), a summary of what came back (≤ 500 chars, never the raw result, BR-13), how long it
 * took, how it ended, and the verdicts the tool point recorded. A destructive call that waited for a
 * person also shows the decision it was given (FR-GRD-006/013): the call carries an `ask_user`
 * verdict and the node run carries the matching `ApprovalDecision`, linked here in the order they
 * occurred since a tool call holds no request id of its own.
 */

/**
 * Green/red/accent by outcome — the tool point's own verdict wording carries the detail. Each is a
 * theme status colour, shown as its mono chip on itself at 12% (`colour + '1f'`, D328).
 */
const STATUS_COLOR: Readonly<Record<ToolCallStatus, string>> = {
  ok: '#2f9e63',
  error: '#c94c27',
  blocked: '#c94c27',
  rejected: '#c94c27',
  timeout: '#e8572e',
};

/** The theme's small-caps label: JetBrains Mono 9.5px, 0.1em, muted, 500. */
const LABEL =
  'font-machine text-[9.5px] font-medium uppercase tracking-[0.1em] text-[var(--muted)]';

export interface ToolCallsTabProps {
  toolCalls: readonly ToolCall[];
  /** The node run's approval decisions, so a destructive call can show the answer it got. */
  approvals?: readonly ApprovalDecision[];
}

/** A call "asked" a person when any of its verdicts took the `ask_user` action (FR-GRD-006). */
const askedForApproval = (call: ToolCall): boolean =>
  call.verdicts.some((verdict) => verdict.action === 'ask_user');

export function ToolCallsTab({ toolCalls, approvals = [] }: ToolCallsTabProps) {
  // A tool call carries no request id, so the Nth call that asked is linked to the Nth decision.
  let decisionCursor = 0;
  const decisionFor = (call: ToolCall): ApprovalDecision | undefined => {
    if (!askedForApproval(call)) return undefined;
    return approvals[decisionCursor++];
  };

  return (
    <section
      aria-label="Tool calls"
      data-testid="inspector-tool-calls"
      className="flex flex-col gap-[7px]"
    >
      <h3 className={`m-0 ${LABEL}`}>Tool calls</h3>

      {toolCalls.length === 0 ? (
        <p data-testid="tool-calls-empty" className="m-0 text-[12px] text-[var(--muted)]">
          No tools called.
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-[6px] p-0">
          {toolCalls.map((call) => (
            <ToolCallRow key={call.id} call={call} decision={decisionFor(call)} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ToolCallRow({ call, decision }: { call: ToolCall; decision?: ApprovalDecision }) {
  return (
    <li
      data-testid={`tool-call-${call.id}`}
      data-status={call.status}
      className="flex flex-col gap-2 rounded-[10px] border border-[var(--line)] bg-[var(--soft)] px-3 py-[10px] text-[12px]"
    >
      <div className="flex items-center justify-between gap-2">
        <span
          data-testid={`tool-call-name-${call.id}`}
          className="truncate font-machine text-[12px] font-medium"
        >
          {call.toolName}
        </span>
        <span className="flex items-center gap-2">
          <span
            data-testid={`tool-call-status-${call.id}`}
            data-status={call.status}
            className="rounded-[4px] px-[6px] py-[2px] font-machine text-[8.5px] font-medium uppercase leading-[1.4] tracking-[0.08em]"
            style={{
              color: STATUS_COLOR[call.status],
              background: `${STATUS_COLOR[call.status]}1f`,
            }}
          >
            {call.status}
          </span>
          <span
            data-testid={`tool-call-duration-${call.id}`}
            className="font-machine text-[10.5px] text-[var(--muted)]"
          >
            {call.durationMs} ms
          </span>
        </span>
      </div>

      <div className="flex flex-col gap-1">
        <span className={LABEL}>args</span>
        <pre
          data-testid={`tool-call-args-${call.id}`}
          className="m-0 overflow-auto rounded-[8px] border border-[var(--line)] bg-[var(--canvas)] px-[10px] py-[8px] font-machine text-[11px]"
        >
          {argsText(call.args)}
        </pre>
      </div>

      <div className="flex flex-col gap-1">
        <span className={LABEL}>result</span>
        <p
          data-testid={`tool-call-result-${call.id}`}
          className="m-0 whitespace-pre-wrap text-[12.5px] leading-[1.5]"
        >
          {call.resultSummary === '' ? '—' : call.resultSummary}
        </p>
      </div>

      {call.verdicts.length > 0 && (
        <div data-testid={`tool-call-verdicts-${call.id}`}>
          <VerdictList verdicts={call.verdicts} />
        </div>
      )}

      {decision !== undefined && (
        <p
          data-testid={`tool-call-approval-${call.id}`}
          data-decision={decision.decision}
          className="m-0 flex flex-wrap items-center gap-1 rounded-[8px] border border-[var(--line)] bg-[var(--canvas)] px-[10px] py-[6px] font-machine text-[11px]"
        >
          {decision.decision === 'approve' ? 'approved' : 'rejected'} ·{' '}
          {new Date(decision.decidedAt).toLocaleTimeString()}
          {decision.note !== undefined && (
            <span className="text-[var(--muted)]">— {decision.note}</span>
          )}
        </p>
      )}
    </li>
  );
}

/** Args are whatever the tool took; render them as pretty JSON, and never throw on a cycle. */
function argsText(args: unknown): string {
  if (args === undefined) return '—';
  try {
    return JSON.stringify(args, null, 2) ?? String(args);
  } catch {
    return String(args);
  }
}
