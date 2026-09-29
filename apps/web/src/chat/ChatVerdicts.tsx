import type { ChatVerdict } from '@ace/contracts';
import { GUARDRAIL_ACTION_LABEL } from '@ace/ui';
import { ShieldX } from 'lucide-react';

/**
 * The verdicts on a refused chat input or a blocked reply (FR-CHAT-008). A `ChatVerdict` is a
 * `Verdict` without a `nodeRunId` — the chat touches no node run (FR-CHAT-005) — so it cannot go
 * through `VerdictBadge`, whose prop is a full `Verdict`; the reason is what the requirement asks
 * for and is rendered directly. A redaction shows only the *types*, never the value (FR-GRD-014).
 */
export function ChatVerdicts({ verdicts }: { verdicts: readonly ChatVerdict[] }) {
  if (verdicts.length === 0) return null;
  return (
    <ul data-testid="chat-verdicts" className="mt-1 flex flex-col gap-1">
      {verdicts.map((verdict) => (
        <li
          key={verdict.id}
          data-testid={`chat-verdict-${verdict.id}`}
          data-action={verdict.action}
          data-point={verdict.point}
          className="flex flex-col gap-0.5 rounded-chip border border-danger/50 bg-danger/5 px-2 py-1 text-[11px]"
        >
          <span className="font-machine text-danger">
            {GUARDRAIL_ACTION_LABEL[verdict.action]} · {verdict.checkType} · {verdict.point}
          </span>
          <span className="text-fg">{verdict.reason}</span>
          {verdict.redactedTypes !== undefined && verdict.redactedTypes.length > 0 && (
            <span className="font-machine text-fg-muted">
              removed {verdict.redactedTypes.join(', ')}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

/** The inline refusal shown when the agent's policy blocks the input before any reply (FR-CHAT-008). */
export function ChatRefusalCard({
  message,
  verdicts,
}: {
  message: string;
  verdicts: readonly ChatVerdict[];
}) {
  return (
    <div
      role="alert"
      data-testid="chat-refusal"
      className="rounded-card border border-danger/60 bg-danger/10 p-3 text-sm text-fg"
    >
      <div className="mb-1 flex items-center gap-1.5 font-machine text-[11px] text-danger">
        <ShieldX className="h-3.5 w-3.5 shrink-0" aria-hidden />
        refused by guardrail
      </div>
      <p>{message}</p>
      <ChatVerdicts verdicts={verdicts} />
    </div>
  );
}
