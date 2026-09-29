import { Check, Copy } from 'lucide-react';
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
 */

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
  1: 'text-fg-muted italic', // comment
  2: 'text-[var(--color-status-COMPLETED)]', // string
  3: 'text-[var(--color-status-WAITING)]', // number
  4: 'text-accent', // keyword
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
    const group = match[1] !== undefined ? 1 : match[2] !== undefined ? 2 : match[3] !== undefined ? 3 : 4;
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
      className={cn('group relative overflow-hidden rounded border border-border bg-canvas', className)}
    >
      <div className="flex items-center justify-between border-b border-border px-2 py-1">
        <span className="font-machine text-[10px] uppercase tracking-wide text-fg-muted">
          {language || 'text'}
        </span>
        <button
          type="button"
          onClick={onCopy}
          aria-label={copied ? 'Copied' : 'Copy code'}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-machine text-[10px] text-fg-muted hover:bg-border/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {copied ? <Check className="h-3 w-3" aria-hidden /> : <Copy className="h-3 w-3" aria-hidden />}
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
      <pre className="overflow-x-auto p-2 font-machine text-xs leading-relaxed text-fg">
        <code data-testid="code-body">{highlight(text)}</code>
      </pre>
    </div>
  );
}
