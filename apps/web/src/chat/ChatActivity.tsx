import type { ActivityItem, ActivityKind } from '@ace/contracts';
import { cn } from '@ace/ui';
import { useState } from 'react';

/** How each kind is counted, in the order the summary lists them. */
const KINDS: readonly { kind: ActivityKind; one: string; many: string; mark: string }[] = [
  { kind: 'edit', one: 'edit', many: 'edits', mark: '✎' },
  { kind: 'write', one: 'new file', many: 'new files', mark: '+' },
  { kind: 'read', one: 'read', many: 'reads', mark: '◦' },
  { kind: 'command', one: 'command', many: 'commands', mark: '›' },
  { kind: 'search', one: 'search', many: 'searches', mark: '⌕' },
  { kind: 'other', one: 'other action', many: 'other actions', mark: '·' },
];

/** "2 edits, 1 read" — every kind the turn did, most consequential first. */
export function activitySummary(items: readonly ActivityItem[]): string {
  return KINDS.flatMap(({ kind, one, many }) => {
    const count = items.filter((item) => item.kind === kind).length;
    return count === 0 ? [] : [`${count} ${count === 1 ? one : many}`];
  }).join(', ');
}

/**
 * What an agent did during a chat turn (D302, design §3.4): one muted line, "What it did: 2 edits,
 * 1 read", that opens to the actions — each the tool's own summary and the file, never its contents.
 */
export function ChatActivity({ items }: { items: readonly ActivityItem[] }) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  return (
    <div className="mt-2" data-testid="chat-activity">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex cursor-pointer items-center gap-[6px] rounded-[6px] border-none bg-transparent p-0 text-[10.5px] text-[var(--muted)] outline-none hover:text-[var(--ink)] focus-visible:shadow-[0_0_0_2px_#ef6b3f]"
      >
        <span aria-hidden className={cn('inline-block transition-transform', open && 'rotate-90')}>
          ›
        </span>
        What it did: {activitySummary(items)}
      </button>
      {open && (
        <ul
          data-testid="chat-activity-list"
          className="m-0 mt-[6px] flex list-none flex-col gap-[3px] border-l border-[var(--line)] py-0 pl-[10px] pr-0"
        >
          {items.map((item, index) => (
            <li
              key={index}
              className="flex min-w-0 items-baseline gap-[6px] text-[11px] text-[var(--ink)]"
            >
              <span aria-hidden className="w-[10px] shrink-0 text-center text-[var(--muted)]">
                {KINDS.find((each) => each.kind === item.kind)?.mark ?? '·'}
              </span>
              <span className="min-w-0 truncate" title={item.summary}>
                {item.summary}
              </span>
              <span className="ml-auto shrink-0 font-machine text-[9px] text-[var(--muted)]">
                {item.tool}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
