import { Readability } from '@mozilla/readability';
import type { ParsedDocument, ParsedHeading } from '@ace/engine';
import { parseHTML } from 'linkedom';

import { decodeText } from './text.js';

/** The parts of a linkedom document used here; the package has no DOM lib, so linkedom's own types fall short. */
export interface DomElement extends DomNode {
  setAttribute(name: string, value: string): void;
}
export interface DomDocument {
  body: DomNode | null;
  documentElement: DomNode;
  querySelectorAll(selector: string): ArrayLike<DomElement>;
}

export function parseDom(html: string): DomDocument {
  return (parseHTML(html) as unknown as { document: DomDocument }).document;
}

const LEVEL_ATTRIBUTE = 'data-ace-level';
const HEADING = /^h([1-6])$/;
/** Never part of the readable text. */
const DROPPED: ReadonlySet<string> = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'nav',
  'header',
  'footer',
  'aside',
  'form',
  'svg',
]);
const BLOCKS: ReadonlySet<string> = new Set([
  'p',
  'div',
  'section',
  'article',
  'main',
  'ul',
  'ol',
  'li',
  'blockquote',
  'pre',
  'table',
  'tr',
  'dl',
  'dt',
  'dd',
  'figure',
  'figcaption',
  'hr',
  'br',
]);
const LINE_BREAKERS: ReadonlySet<string> = new Set(['li', 'br', 'tr']);
/** An article shorter than this is more likely a mis-detection than the page's content. */
const MIN_ARTICLE_CHARS = 120;

export interface DomNode {
  nodeType: number;
  nodeName: string;
  textContent: string | null;
  childNodes: ArrayLike<DomNode>;
  getAttribute?(name: string): string | null;
}

/** Walks a DOM into plain text: blocks separated by blank lines, headings recorded with offsets. */
export function domToText(root: DomNode, dropped: ReadonlySet<string> = DROPPED): ParsedDocument {
  let out = '';
  const headings: ParsedHeading[] = [];

  const breakTo = (newlines: number): void => {
    if (out === '') return;
    const trailing = /\n*$/.exec(out)?.[0].length ?? 0;
    if (trailing < newlines) out += '\n'.repeat(newlines - trailing);
  };
  const addText = (raw: string): void => {
    const collapsed = raw.replace(/\s+/g, ' ');
    const startsClean = out === '' || out.endsWith('\n') || out.endsWith(' ');
    out += startsClean ? collapsed.trimStart() : collapsed;
  };

  const walk = (node: DomNode): void => {
    if (node.nodeType === 3) {
      addText(node.textContent ?? '');
      return;
    }
    if (node.nodeType !== 1) return;
    const name = node.nodeName.toLowerCase();
    if (dropped.has(name)) return;
    const level = HEADING.exec(name)?.[1];
    if (level !== undefined) {
      const title = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (title === '') return;
      breakTo(2);
      const declared = Number(node.getAttribute?.(LEVEL_ATTRIBUTE) ?? level);
      headings.push({ level: declared, title, offset: out.length });
      out += title;
      breakTo(2);
      return;
    }
    const isBlock = BLOCKS.has(name);
    const gap = LINE_BREAKERS.has(name) ? 1 : 2;
    if (isBlock) breakTo(gap);
    if (name === 'li') out += '- ';
    for (const child of Array.from(node.childNodes)) walk(child);
    if (name === 'td' || name === 'th') out += ' ';
    if (isBlock) breakTo(gap);
  };

  walk(root);
  const text = out.replace(/[ \t]+\n/g, '\n').trimEnd();
  return { text, headings: headings.filter((h) => h.offset < text.length) };
}

/** Parses HTML: the readable article when one is found, otherwise the body minus chrome. */
export function parseHtml(bytes: Uint8Array): ParsedDocument {
  const html = decodeText(bytes);
  const document = parseDom(html);

  // Readability renames every h1 to h2, so the original level is stashed to survive it.
  for (const heading of Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6'))) {
    heading.setAttribute(LEVEL_ATTRIBUTE, heading.nodeName.slice(1));
  }
  const fallback = domToText(document.body ?? document.documentElement);

  let article: ParsedDocument | null = null;
  try {
    const parsed = new Readability(
      document as unknown as ConstructorParameters<typeof Readability>[0],
    ).parse();
    if (parsed?.content) {
      const articleBody = parseDom(`<html><body>${parsed.content}</body></html>`).body;
      article = articleBody === null ? null : domToText(articleBody);
    }
  } catch {
    article = null;
  }
  return article !== null && article.text.length >= MIN_ARTICLE_CHARS ? article : fallback;
}
