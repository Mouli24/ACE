import type { ChatVerdict } from '@ace/contracts';
import { GUARDRAIL_ACTION_LABEL } from '@ace/ui';

/**
 * The card a guardrail or a failure note sits in, in the theme's tokens (D335): the surface
 * card with the theme's line, a 11px `#c94c27` heading and 12px ink body.
 */
export const CHAT_NOTE_CLASS =
  'rounded-[12px] border border-[var(--line)] bg-[var(--surface)] px-[12px] py-[10px] text-[12px] leading-[1.45] text-[var(--ink)]';
export const CHAT_NOTE_HEAD_CLASS =
  'mb-1 flex flex-wrap items-center gap-[6px] text-[11px] font-semibold text-danger';

/**
 * The verdicts on a refused chat input or a blocked reply (FR-CHAT-008). A `ChatVerdict` is a
 * `Verdict` without a `nodeRunId` — the chat touches no node run (FR-CHAT-005) — so it cannot go
 * through `VerdictBadge`, whose prop is a full `Verdict`; the reason is what the requirement asks
 * for and is rendered directly. A redaction shows only the *types*, never the value (FR-GRD-014).
 */
export function ChatVerdicts({ verdicts }: { verdicts: readonly ChatVerdict[] }) {
  if (verdicts.length === 0) return null;
  return (
    <ul data-testid="chat-verdicts" className="mt-1 flex flex-col gap-[6px]">
      {verdicts.map((verdict) => (
        <li
          key={verdict.id}
          data-testid={`chat-verdict-${verdict.id}`}
          data-action={verdict.action}
          data-point={verdict.point}
          className="flex flex-col gap-[2px] rounded-[9px] border border-[var(--line)] bg-[var(--canvas)] px-[10px] py-[6px] text-[11px] leading-[1.4]"
        >
          <span className="font-machine text-danger">
            {GUARDRAIL_ACTION_LABEL[verdict.action]} · {verdict.checkType} · {verdict.point}
          </span>
          <span className="text-[12px] text-[var(--ink)]">{verdict.reason}</span>
          {verdict.redactedTypes !== undefined && verdict.redactedTypes.length > 0 && (
            <span className="font-machine text-[var(--muted)]">
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
    <div role="alert" data-testid="chat-refusal" className={CHAT_NOTE_CLASS}>
      <div className={CHAT_NOTE_HEAD_CLASS}>refused by guardrail</div>
      <p>{message}</p>
      <ChatVerdicts verdicts={verdicts} />
    </div>
  );
}
