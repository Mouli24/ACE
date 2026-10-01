import type { SearchVia } from '@ace/contracts';
import { FileText } from 'lucide-react';

import { cn } from '../lib/cn.js';

/**
 * One retrieval source behind an answer (FR-RAG-007): where the chunk came from, how well it
 * matched (0..1, two decimals) and, optionally, which index found it (`vector`, `keyword`, `both`).
 * A link when given `href`, a button when given `onOpen`, plain text otherwise.
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
  'inline-flex max-w-full items-center gap-1.5 rounded-chip border border-border bg-card px-2 py-0.5 text-xs text-fg';
const interactiveClass =
  'hover:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent';

export function SourceChip({ source, score, via, onOpen, href, className }: SourceChipProps) {
  const scoreText = score === undefined ? undefined : formatScore(score);
  const label = `Source ${source}${scoreText ? `, score ${scoreText}` : ''}${via ? `, via ${via}` : ''}`;
  const content = (
    <>
      <FileText aria-hidden className="size-3 shrink-0 text-fg-muted" />
      <span className="truncate">{source}</span>
      {scoreText ? (
        <span className="font-machine text-[11px] text-fg-muted" data-testid="source-score">
          {scoreText}
        </span>
      ) : null}
      {via ? (
        <span
          className="rounded-chip border border-border px-1.5 font-machine text-[10px] uppercase text-fg-muted"
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
