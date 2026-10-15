import { Check } from 'lucide-react';
import { Fragment, useState, type ReactNode } from 'react';

import { cn } from '../lib/cn.js';

/**
 * A code part: the language label, a copy button, and lightly highlighted source (FR-MM-006,
 * round 4 §5 item 3).
 *
 * Highlighting is a single-pass, language-agnostic tokeniser — no highlighting library, so nothing
 * heavy lands in a package the web app bundles, and the highlighter emits React spans rather than
 * HTML, so the source can never be interpreted as markup. The one invariant it guarantees, and the
 * one the test pins, is that the concatenation of every rendered token equals the input byte for
 * byte: colour is added, text is never changed.
 *
 * The look is the theme's (D328): JetBrains Mono 12px on the canvas colour, radius 8, and the
 * colours of its syntax palette — `PAL_L` in light, `PAL_D` in dark — carried as CSS variables by
 * {@link SYNTAX_PALETTE_CLASS}, so one class list serves both themes.
 */

/**
 * The theme's syntax palette as CSS variables (`--syn-kw`, `--syn-str`, `--syn-num`, `--syn-com`,
 * `--syn-fn`, `--syn-type`): `PAL_L` by default, `PAL_D` under `:root[data-theme='dark']`. Put it
 * on a container; anything inside reads its colour from those variables.
 */
export const SYNTAX_PALETTE_CLASS =
  '[--syn-kw:#7a4fd0] [--syn-str:#2f8a57] [--syn-num:#d2542a] [--syn-com:#8a837c] [--syn-fn:#1a8792] [--syn-type:#a86f12] ' +
  '[:root[data-theme=dark]_&]:[--syn-kw:#b49cf5] [:root[data-theme=dark]_&]:[--syn-str:#7cc99a] [:root[data-theme=dark]_&]:[--syn-num:#f39a72] [:root[data-theme=dark]_&]:[--syn-com:#7d7771] [:root[data-theme=dark]_&]:[--syn-fn:#5cc3cc] [:root[data-theme=dark]_&]:[--syn-type:#f2c14e]';

export interface CodeBlockProps {
  language: string;
  text: string;
  className?: string;
}

/** comments · strings · numbers · a small common-keyword set, in that precedence. */
const TOKEN_RE = new RegExp(
  [
    '(\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/|(?:^|(?<=\\s))#[^\\n]*)', // 1 comment
    '("(?:\\\\.|[^"\\\\])*"|\'(?:\\\\.|[^\'\\\\])*\'|`(?:\\\\.|[^`\\\\])*`)', // 2 string
    '(\\b\\d[\\d_]*(?:\\.\\d+)?\\b)', // 3 number
    '(\\b(?:const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|import|export|from|default|class|extends|new|this|await|async|yield|try|catch|finally|throw|typeof|instanceof|in|of|def|lambda|None|True|False|elif|pass|with|as|and|or|not|public|private|protected|static|void|int|float|string|bool|boolean|null|true|false|undefined|interface|type|enum|struct|func|package|fn|let|match)\\b)', // 4 keyword
  ].join('|'),
  'g',
);

const CLASS_FOR: Readonly<Record<number, string>> = {
  1: 'text-[var(--syn-com)] italic', // comment
  2: 'text-[var(--syn-str)]', // string
  3: 'text-[var(--syn-num)]', // number
  4: 'text-[var(--syn-kw)]', // keyword
};

/** Split source into coloured spans; the gaps between matches are emitted as plain text. */
export function highlight(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  let i = 0;
  TOKEN_RE.lastIndex = 0;
  while ((match = TOKEN_RE.exec(text)) !== null) {
    // A zero-width match would loop forever; step past it.
    if (match.index === TOKEN_RE.lastIndex) {
      TOKEN_RE.lastIndex += 1;
      continue;
    }
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const group =
      match[1] !== undefined ? 1 : match[2] !== undefined ? 2 : match[3] !== undefined ? 3 : 4;
    nodes.push(
      <span key={`t${i++}`} className={CLASS_FOR[group]}>
        {match[0]}
      </span>,
    );
    last = match.index + match[0].length;
  }
  if (last < text.length) nodes.push(<Fragment key="tail">{text.slice(last)}</Fragment>);
  return nodes;
}

export function CodeBlock({ language, text, className }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const onCopy = () => {
    void (async () => {
      try {
        await navigator.clipboard?.writeText(text);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      } catch {
        setCopied(false);
      }
    })();
  };

  return (
    <div
      data-testid="code-block"
      data-language={language}
      className={cn(
        'group relative overflow-hidden rounded-[8px] border border-[var(--line)] bg-[var(--canvas)]',
        SYNTAX_PALETTE_CLASS,
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2 border-b border-[var(--line)] py-[5px] pl-3 pr-[6px]">
        <span className="font-machine text-[9.5px] font-medium uppercase tracking-[0.1em] text-[var(--muted)]">
          {language || 'text'}
        </span>
        <button
          type="button"
          onClick={onCopy}
          aria-label={copied ? 'Copied' : 'Copy code'}
          className="inline-flex h-[22px] cursor-pointer items-center gap-[5px] rounded-full border border-[var(--line)] bg-[var(--chip)] px-[9px] text-[10.5px] font-semibold text-[var(--ink)] outline-none hover:bg-[var(--hover)] focus-visible:shadow-[0_0_0_2px_#ef6b3f]"
        >
          {copied && <Check aria-hidden size={11} strokeWidth={2.6} className="text-[#2f9e63]" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="overflow-x-auto px-3 py-[10px] font-machine text-[12px] leading-[1.55] text-[var(--ink)]">
        <code data-testid="code-body">{highlight(text)}</code>
      </pre>
    </div>
  );
}
