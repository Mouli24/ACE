/**
 * A small `.eml` reader for importing one message as an Inbox task (ACE parity P2, D282).
 *
 * It reads what a task needs — sender, recipients, subject, date and the text of the message — and
 * nothing else: attachments are dropped (ACE: "attachments are excluded"). Headers may be folded and
 * RFC 2047-encoded; bodies may be multipart, quoted-printable or base64, in UTF-8 or Latin-1. With no
 * `text/plain` part, the HTML part is reduced to text.
 */

export interface ParsedEmail {
  from: string;
  to: string;
  subject: string;
  date: string;
  /** The text body, trimmed; empty when the message has none. */
  text: string;
}

interface Part {
  headers: Map<string, string>;
  body: string;
}

const BODY_LIMIT = 20_000;

function splitHeaders(raw: string): Part {
  const normalised = raw.replace(/\r\n/g, '\n');
  const blank = normalised.indexOf('\n\n');
  const head = blank === -1 ? normalised : normalised.slice(0, blank);
  const body = blank === -1 ? '' : normalised.slice(blank + 2);
  const headers = new Map<string, string>();
  let current: string | undefined;
  for (const line of head.split('\n')) {
    if (/^[ \t]/.test(line) && current !== undefined) {
      headers.set(current, `${headers.get(current) ?? ''} ${line.trim()}`);
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    current = line.slice(0, colon).trim().toLowerCase();
    // The first occurrence wins (a forwarded message repeats headers further down).
    if (!headers.has(current)) headers.set(current, line.slice(colon + 1).trim());
    else current = undefined;
  }
  return { headers, body };
}

function decodeBytes(bytes: Uint8Array, charset: string): string {
  const name = charset.toLowerCase().replace(/^"|"$/g, '');
  try {
    return new TextDecoder(name === '' ? 'utf-8' : name).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

function quotedPrintableBytes(text: string): Uint8Array {
  const soft = text.replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let index = 0; index < soft.length; index += 1) {
    const char = soft[index];
    if (char === '=' && /^[0-9A-Fa-f]{2}$/.test(soft.slice(index + 1, index + 3))) {
      bytes.push(parseInt(soft.slice(index + 1, index + 3), 16));
      index += 2;
    } else {
      bytes.push(...Buffer.from(char ?? '', 'utf8'));
    }
  }
  return Uint8Array.from(bytes);
}

/** RFC 2047 encoded words: `=?utf-8?B?…?=` and `=?iso-8859-1?Q?…?=`. */
export function decodeHeader(value: string): string {
  return value
    .replace(/\?=\s+=\?/g, '?==?')
    .replace(
      /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g,
      (_match, charset: string, encoding: string, text: string) => {
        const bytes =
          encoding.toUpperCase() === 'B'
            ? Uint8Array.from(Buffer.from(text, 'base64'))
            : quotedPrintableBytes(text.replace(/_/g, ' '));
        return decodeBytes(bytes, charset);
      },
    );
}

function param(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  const match = new RegExp(`${name}\\s*=\\s*("([^"]*)"|[^;\\s]+)`, 'i').exec(header);
  return match === null ? undefined : (match[2] ?? match[1]);
}

function decodeBody(part: Part): string {
  const encoding = (part.headers.get('content-transfer-encoding') ?? '7bit').toLowerCase();
  const charset = param(part.headers.get('content-type'), 'charset') ?? 'utf-8';
  if (encoding === 'base64') {
    return decodeBytes(
      Uint8Array.from(Buffer.from(part.body.replace(/\s+/g, ''), 'base64')),
      charset,
    );
  }
  if (encoding === 'quoted-printable') return decodeBytes(quotedPrintableBytes(part.body), charset);
  return part.body;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** HTML reduced to readable text: block ends become line breaks, tags go, entities are decoded. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
      if (entity.startsWith('#x') || entity.startsWith('#X')) {
        return String.fromCodePoint(parseInt(entity.slice(2), 16));
      }
      if (entity.startsWith('#')) return String.fromCodePoint(parseInt(entity.slice(1), 10));
      return ENTITIES[entity.toLowerCase()] ?? match;
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
}

/** The text of a part: its own text, or the best text inside a multipart one. */
function textOf(part: Part, depth = 0): { plain?: string; html?: string } {
  const type = (part.headers.get('content-type') ?? 'text/plain').toLowerCase();
  const disposition = (part.headers.get('content-disposition') ?? '').toLowerCase();
  if (disposition.startsWith('attachment')) return {};
  if (type.startsWith('multipart/') && depth < 5) {
    const boundary = param(part.headers.get('content-type'), 'boundary');
    if (boundary === undefined) return {};
    const found: { plain?: string; html?: string } = {};
    for (const chunk of part.body.split(`--${boundary}`).slice(1)) {
      if (chunk.startsWith('--')) break;
      const inner = textOf(splitHeaders(chunk.replace(/^\r?\n/, '')), depth + 1);
      if (found.plain === undefined && inner.plain !== undefined) found.plain = inner.plain;
      if (found.html === undefined && inner.html !== undefined) found.html = inner.html;
    }
    return found;
  }
  if (type.startsWith('text/plain')) return { plain: decodeBody(part) };
  if (type.startsWith('text/html')) return { html: decodeBody(part) };
  return {};
}

export function parseEmail(raw: string): ParsedEmail {
  const message = splitHeaders(raw);
  const header = (name: string): string => decodeHeader(message.headers.get(name) ?? '').trim();
  const { plain, html } = textOf(message);
  const text = (plain ?? (html === undefined ? '' : htmlToText(html))).trim().slice(0, BODY_LIMIT);
  return {
    from: header('from'),
    to: header('to'),
    subject: header('subject'),
    date: header('date'),
    text,
  };
}
