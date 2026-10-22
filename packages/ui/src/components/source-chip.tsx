import type { SearchVia } from '@ace/contracts';

import { cn } from '../lib/cn.js';

/**
 * One retrieval source behind an answer (FR-RAG-007): where the chunk came from, how well it
 * matched (0..1, two decimals) and, optionally, which index found it (`vector`, `keyword`, `both`).
 * A link when given `href`, a button when given `onOpen`, plain text otherwise.
 *
 * In the theme (D328) it is the handle pill — 22px, hairline, radius 999 — with the score in mono
 * and the index as a mono chip.
 */

export interface SourceChipProps {
  source: string;
  /** Match score in 0..1; clamped, shown to two decimals. */
  score?: number;
  via?: SearchVia;
  onOpen?: () => void;
  href?: string;
  className?: string;
}

export function formatScore(score: number): string {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(score) ? score : 0));
  return clamped.toFixed(2);
}

const chipClass =
  'inline-flex h-[22px] max-w-full items-center gap-[6px] rounded-full border border-[var(--line)] bg-[var(--surface)] px-[8px] text-[11.5px] text-[var(--ink)] no-underline';
const interactiveClass =
  'cursor-pointer outline-none hover:bg-[var(--hover)] hover:text-[var(--ink)] focus-visible:shadow-[0_0_0_2px_var(--focus)]';

export function SourceChip({ source, score, via, onOpen, href, className }: SourceChipProps) {
  const scoreText = score === undefined ? undefined : formatScore(score);
  const label = `Source ${source}${scoreText ? `, score ${scoreText}` : ''}${via ? `, via ${via}` : ''}`;
  const content = (
    <>
      <span className="truncate">{source}</span>
      {scoreText ? (
        <span className="font-machine text-[10.5px] text-[var(--muted)]" data-testid="source-score">
          {scoreText}
        </span>
      ) : null}
      {via ? (
        <span
          className="rounded-[4px] bg-[var(--hover)] px-[6px] py-px font-machine text-[8.5px] font-medium uppercase tracking-[0.08em] text-[var(--muted)]"
          data-testid="source-via"
        >
          {via}
        </span>
      ) : null}
    </>
  );

  if (href) {
    return (
      <a
        href={href}
        aria-label={label}
        title={source}
        className={cn(chipClass, interactiveClass, className)}
        data-testid="source-chip"
        onClick={onOpen ? () => onOpen() : undefined}
      >
        {content}
      </a>
    );
  }
  if (onOpen) {
    return (
      <button
        type="button"
        aria-label={label}
        title={source}
        className={cn(chipClass, interactiveClass, className)}
        data-testid="source-chip"
        onClick={onOpen}
      >
        {content}
      </button>
    );
  }
  return (
    <span
      aria-label={label}
      title={source}
      className={cn(chipClass, className)}
      data-testid="source-chip"
    >
      {content}
    </span>
  );
}
