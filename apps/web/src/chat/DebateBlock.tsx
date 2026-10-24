import type { ChatDebatePayload, ChatMessage } from '@ace/contracts';
import { cn, Icons } from '@ace/ui';
import { useState, type ReactNode } from 'react';

const FOCUS = 'focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_var(--focus)]';

/**
 * What each turn of a debate was, by its place: the Defender's opening answer, then an attack and a
 * defence per round, then — from a third speaker — the Judge's verdict (D405).
 */
export function debateTurnLabel(turns: readonly ChatMessage[], index: number): string {
  const debaters = new Set([turns[0]?.speakerNodeId, turns[1]?.speakerNodeId]);
  const turn = turns[index];
  if (index >= 2 && turn !== undefined && !debaters.has(turn.speakerNodeId)) return 'Verdict';
  if (index === 0) return 'Opening answer';
  const round = Math.ceil(index / 2);
  return index % 2 === 1 ? `Round ${round} · attack` : `Round ${round} · defence`;
}

/** The line that says which turn is under way, from `chat.debate`. */
function progressText(progress: ChatDebatePayload, nameOf: (nodeId?: string) => string): string {
  const who = nameOf(progress.speakerNodeId);
  if (progress.role === 'judge') return `${who} is judging the debate…`;
  if (progress.round === undefined) return `${who} is writing the opening answer…`;
  const verb = progress.role === 'attacker' ? 'attacking' : 'answering the attack';
  return `Round ${progress.round} · ${who} is ${verb}…`;
}

/**
 * A debate in the conversation (D405): the turns after the person's `@debate` message. While it runs,
 * every turn so far sits in the collapsed "Debate" with a line saying who speaks now. Once it is over,
 * the last turn — the Defender's final answer, or the Judge's verdict — stands below it as the result:
 * the person asked for the answer, and the argument is there to open.
 */
export function DebateBlock({
  turns,
  progress,
  nameOf,
  renderTurn,
}: {
  turns: readonly ChatMessage[];
  /** This debate's `chat.debate` progress, when it is the one reported on the thread. */
  progress: ChatDebatePayload | undefined;
  nameOf: (nodeId?: string) => string;
  renderTurn: (message: ChatMessage) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const running = progress?.state === 'turn';
  const result = running ? undefined : turns.at(-1);
  const argument = result === undefined ? turns : turns.slice(0, -1);
  const names = [...new Set(turns.slice(0, 2).map((turn) => nameOf(turn.speakerNodeId)))];
  const rounds = Math.max(0, Math.ceil((argument.length - 1) / 2));

  return (
    <div data-testid="chat-debate" className="flex flex-col gap-[12px]">
      {argument.length > 0 && (
        <button
          type="button"
          aria-expanded={open}
          data-testid="chat-debate-toggle"
          onClick={() => setOpen(!open)}
          className={cn(
            FOCUS,
            'flex cursor-pointer items-center gap-1 self-start rounded-[6px] border-none bg-transparent p-0 pl-[36px] text-[11px] text-[var(--muted)] hover:text-[var(--ink)]',
          )}
        >
          {open ? (
            <Icons.ChevronDown aria-hidden size={12} />
          ) : (
            <Icons.ChevronRight aria-hidden size={12} />
          )}
          <Icons.MessagesSquare aria-hidden size={12} />
          Debate{names.length === 0 ? '' : ` · ${names.join(' ⇄ ')}`}
          <span className="text-[10px]">
            ({rounds === 0 ? 'opening' : `${rounds} ${rounds === 1 ? 'round' : 'rounds'}`},{' '}
            {argument.length} {argument.length === 1 ? 'turn' : 'turns'})
          </span>
        </button>
      )}
      {open && (
        <div
          data-testid="chat-debate-turns"
          className="ml-[12px] flex flex-col gap-[16px] border-l-2 border-[var(--line)] pl-[12px]"
        >
          {argument.map((turn, index) => (
            <div key={turn.id} className="flex flex-col gap-[4px]">
              <span className="pl-[36px] font-machine text-[9.5px] uppercase tracking-[0.04em] text-[var(--muted)]">
                {debateTurnLabel(turns, index)}
              </span>
              {renderTurn(turn)}
            </div>
          ))}
        </div>
      )}
      {running && progress !== undefined && (
        <p
          role="status"
          data-testid="chat-debate-progress"
          className="flex items-center gap-2 pl-[36px] text-[11px] text-[var(--muted)]"
        >
          <Icons.Circle
            aria-hidden
            size={8}
            className="animate-[livePulse_1s_ease-in-out_infinite] fill-current"
          />
          {progressText(progress, nameOf)}
          <span className="text-[10px]">
            ({progress.step} of {progress.total})
          </span>
        </p>
      )}
      {result !== undefined && (
        <div data-testid="chat-debate-result" className="flex flex-col gap-[4px]">
          <span className="pl-[36px] font-machine text-[9.5px] uppercase tracking-[0.04em] text-[#ef6b3f]">
            {result.error !== undefined
              ? 'The debate stopped here'
              : debateTurnLabel(turns, turns.length - 1) === 'Verdict'
                ? "Judge's verdict and final answer"
                : 'Final answer'}
          </span>
          {renderTurn(result)}
        </div>
      )}
    </div>
  );
}
