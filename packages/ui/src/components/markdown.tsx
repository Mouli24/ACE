import { Fragment, type ReactNode } from 'react';

import { cn } from '../lib/cn.js';

/**
 * A dependency-free, safe-by-construction Markdown renderer (FR-MM-006, round 4 §5 item 3).
 *
 * There is no Markdown library in the workspace, and pulling one in — with its transitive HTML
 * sanitiser — is more surface than a text part needs. This renders to React elements only: it
 * never builds an HTML string and never touches `dangerouslySetInnerHTML`, so a `<script>` in a
 * model's output is text, not markup. It is not a complete CommonMark implementation; it covers
 * the blocks an agent's answer actually uses — headings, paragraphs, fenced and inline code,
 * lists, blockquotes, thematic breaks — plus inline bold, italic, code and links.
 *
 * Links keep only `http:`, `https:` and `mailto:`; any other protocol renders as plain text, so a
 * `javascript:` URL cannot become a live link. Everything wraps, so it holds at 380 px (NFR-USE-03).
 */

export interface MarkdownProps {
  text: string;
  className?: string;
}

const SAFE_LINK = /^(https?:|mailto:)/i;

/**
 * A line longer than this is shown as typed, with no inline marks [audit S-10]: no answer writes
 * 8,000 characters without a line break, and parsing marks across one is all cost and no reading.
 */
const INLINE_MAX_CHARS = 8_000;

/** Split inline text into React nodes: `**bold**`, `*italic*`/`_italic_`, `` `code` `` and links. */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  if (text.length > INLINE_MAX_CHARS) return [text];
  const nodes: ReactNode[] = [];
  // One pass, longest-delimiter-first, so `**` is not eaten by `*`. [audit S-10]: a link's text and
  // its URL stop at the next `[` and are bounded (500 / 2,000), so an unclosed `[` or `](` scans to
  // the next `[` at most, never to the end of the line — 20,000 `[a](` were 1.3 s a render.
  const pattern =
    /(\*\*([^*]+)\*\*)|(`([^`]+)`)|(\*([^*]+)\*)|(_([^_]+)_)|(\[([^[\]]{1,500})\]\(([^)[\s]{1,2000})\))/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let i = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const key = `${keyPrefix}-i${i++}`;
    if (match[2] !== undefined) {
      nodes.push(<strong key={key}>{match[2]}</strong>);
    } else if (match[4] !== undefined) {
      nodes.push(
        <code
          key={key}
          className="rounded-[4px] bg-[var(--hover)] px-[5px] py-px font-machine text-[0.88em] text-[var(--ink)]"
        >
          {match[4]}
        </code>,
      );
    } else if (match[6] !== undefined) {
      nodes.push(<em key={key}>{match[6]}</em>);
    } else if (match[8] !== undefined) {
      nodes.push(<em key={key}>{match[8]}</em>);
    } else if (match[10] !== undefined && match[11] !== undefined) {
      const href = match[11];
      if (SAFE_LINK.test(href)) {
        nodes.push(
          <a
            key={key}
            href={href}
            target="_blank"
            rel="noreferrer noopener"
            className="text-[#e8623a] underline underline-offset-2 hover:text-[#c94c27]"
          >
            {match[10]}
          </a>,
        );
      } else {
        nodes.push(match[9]);
      }
    }
    last = pattern.lastIndex;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'code'; language: string; text: string }
  | { kind: 'quote'; text: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; items: string[] }
  | { kind: 'hr' }
  | { kind: 'p'; text: string };

/** Group the source into blocks; fenced code is taken verbatim and never parsed for inline marks. */
function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';

    const fence = /^```(.*)$/.exec(line.trim());
    if (fence) {
      const language = fence[1]?.trim() ?? '';
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^```/.test((lines[i] ?? '').trim())) {
        body.push(lines[i] ?? '');
        i += 1;
      }
      i += 1; // closing fence (or end of input)
      blocks.push({ kind: 'code', language, text: body.join('\n') });
      continue;
    }

    if (line.trim() === '') {
      i += 1;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      blocks.push({ kind: 'hr' });
      i += 1;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1]!.length, text: heading[2]!.trim() });
      i += 1;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i] ?? '')) {
        body.push((lines[i] ?? '').replace(/^>\s?/, ''));
        i += 1;
      }
      blocks.push({ kind: 'quote', text: body.join('\n') });
      continue;
    }

    if (/^[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*+]\s+/.test(lines[i] ?? '')) {
        items.push((lines[i] ?? '').replace(/^[-*+]\s+/, ''));
        i += 1;
      }
      blocks.push({ kind: 'ul', items });
      continue;
    }

    if (/^\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+[.)]\s+/.test(lines[i] ?? '')) {
        items.push((lines[i] ?? '').replace(/^\d+[.)]\s+/, ''));
        i += 1;
      }
      blocks.push({ kind: 'ol', items });
      continue;
    }

    const para: string[] = [];
    while (
      i < lines.length &&
      (lines[i] ?? '').trim() !== '' &&
      !/^```/.test((lines[i] ?? '').trim()) &&
      !/^(#{1,6})\s+/.test(lines[i] ?? '') &&
      !/^>\s?/.test(lines[i] ?? '') &&
      !/^[-*+]\s+/.test(lines[i] ?? '') &&
      !/^\d+[.)]\s+/.test(lines[i] ?? '')
    ) {
      para.push(lines[i] ?? '');
      i += 1;
    }
    blocks.push({ kind: 'p', text: para.join('\n') });
  }
  return blocks;
}

/** The theme's type scale: 16 / 14.5 / 13.5 / 13 at 700, then its mono small-caps label. */
const HEADING_CLASS: Readonly<Record<number, string>> = {
  1: 'text-[16px] font-bold tracking-[-0.01em]',
  2: 'text-[14.5px] font-bold tracking-[-0.01em]',
  3: 'text-[13.5px] font-bold',
  4: 'text-[13px] font-bold',
  5: 'font-machine text-[9.5px] font-medium uppercase tracking-[0.1em] text-[var(--muted)]',
  6: 'font-machine text-[9.5px] font-medium uppercase tracking-[0.1em] text-[var(--muted)]',
};

/** Text with paragraph soft-breaks preserved as `<br>`. */
function withBreaks(text: string, keyPrefix: string): ReactNode[] {
  const parts = text.split('\n');
  const out: ReactNode[] = [];
  parts.forEach((part, index) => {
    if (index > 0) out.push(<br key={`${keyPrefix}-br${index}`} />);
    out.push(
      <Fragment key={`${keyPrefix}-t${index}`}>
        {renderInline(part, `${keyPrefix}-${index}`)}
      </Fragment>,
    );
  });
  return out;
}

/** Render Markdown text as safe React elements. */
export function Markdown({ text, className }: MarkdownProps) {
  const blocks = parseBlocks(text);
  return (
    <div
      data-testid="markdown"
      className={cn(
        'space-y-2 break-words font-human text-[13px] leading-[1.55] text-[var(--ink)]',
        className,
      )}
    >
      {blocks.map((block, index) => {
        const key = `b${index}`;
        switch (block.kind) {
          case 'heading': {
            const Tag = `h${block.level}` as 'h1';
            return (
              <Tag key={key} className={HEADING_CLASS[block.level]}>
                {renderInline(block.text, key)}
              </Tag>
            );
          }
          case 'code':
            return (
              <pre
                key={key}
                className="overflow-x-auto rounded-[8px] border border-[var(--line)] bg-[var(--canvas)] px-3 py-[10px] font-machine text-[12px] leading-[1.55] text-[var(--ink)]"
              >
                <code>{block.text}</code>
              </pre>
            );
          case 'quote':
            return (
              <blockquote
                key={key}
                className="border-l-2 border-[var(--line)] pl-3 text-[var(--muted)]"
              >
                {withBreaks(block.text, key)}
              </blockquote>
            );
          case 'ul':
            return (
              <ul key={key} className="flex list-none flex-col gap-[6px] p-0">
                {block.items.map((item, j) => (
                  <li key={`${key}-${j}`} className="flex gap-2">
                    <span aria-hidden className="text-[#ef6b3f]">
                      •
                    </span>
                    <span className="min-w-0">{renderInline(item, `${key}-${j}`)}</span>
                  </li>
                ))}
              </ul>
            );
          case 'ol':
            return (
              <ol
                key={key}
                className="list-decimal space-y-[6px] pl-5 marker:font-machine marker:text-[11px] marker:text-[var(--muted)]"
              >
                {block.items.map((item, j) => (
                  <li key={`${key}-${j}`}>{renderInline(item, `${key}-${j}`)}</li>
                ))}
              </ol>
            );
          case 'hr':
            return <hr key={key} className="border-0 border-t border-[var(--line)]" />;
          case 'p':
          default:
            return (
              <p key={key} className="whitespace-pre-wrap break-words">
                {withBreaks(block.text, key)}
              </p>
            );
        }
      })}
    </div>
  );
}
