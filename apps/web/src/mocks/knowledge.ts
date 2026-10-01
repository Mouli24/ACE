import {
  fuseRankings,
  type HiddenInstructionType,
  type KbChunk,
  type KbDocument,
  type KbDocumentStatus,
  type KnowledgeBase,
  type SearchHit,
  type SearchMode,
  type SearchResponse,
} from '@ace/contracts';

import { newId } from '../lib/ulid';
import type { MockDb } from './db';
import { DOCX_MIME } from './knowledge-fixtures';
import { readZip } from './zip';

/**
 * The mock engine's knowledge pipeline (round 5 §2.1, FR-RAG-002..009, Arch §12.6, §21.3): parse,
 * chunk, "embed", index, and the hybrid search over it. Deliberately small, but real enough that the
 * UI's questions have honest answers — a rare term is found by the keyword arm, a paraphrase by the
 * vector arm, a corrupt file fails with a reason, and a deleted document's text is gone.
 *
 * The vector arm is a toy: a bag of normalised words, with a small synonym table standing in for
 * what an embedding model knows, compared by cosine. Fusion is the contract's own `fuseRankings`
 * (D231), so scores and `via` mean what they mean on the real engine.
 */

/* -------------------------------------------------------------------------- */
/* Parsing (Arch §21.3)                                                        */
/* -------------------------------------------------------------------------- */

export type ParseResult = { ok: true; text: string } | { ok: false; reason: string };

const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
};

const CODE_EXTENSIONS = new Set(['ts', 'tsx', 'js', 'jsx', 'py', 'go', 'rs', 'java', 'css']);

export const isCodeDocument = (name: string): boolean => CODE_EXTENSIONS.has(extensionOf(name));

const decodeEntities = (text: string): string =>
  text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');

/** The text of a PDF's `Tj` strings, one per line; empty when it has no text layer we can read. */
function pdfText(bytes: Uint8Array): string {
  const raw = new TextDecoder('latin1').decode(bytes);
  const lines: string[] = [];
  const tj = /\(((?:\\.|[^\\)])*)\)\s*Tj/g;
  for (let match = tj.exec(raw); match !== null; match = tj.exec(raw)) {
    lines.push(match[1]!.replace(/\\(.)/g, '$1'));
  }
  return lines.join('\n\n');
}

/** A Word document's paragraphs; a `Heading` style becomes a Markdown heading. */
function docxText(bytes: Uint8Array): string | undefined {
  const document = readZip(bytes)?.get('word/document.xml');
  if (document === undefined) return undefined;
  const xml = new TextDecoder().decode(document);
  return xml
    .split('</w:p>')
    .map((paragraph) => {
      const text = [...paragraph.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)]
        .map((match) => decodeEntities(match[1]!))
        .join('');
      if (text.trim() === '') return '';
      return /<w:pStyle w:val="Heading\d"\/>/.test(paragraph) ? `# ${text}` : text;
    })
    .filter((paragraph) => paragraph !== '')
    .join('\n\n');
}

/** Visible text of an HTML page, its headings kept as Markdown headings. Comments are dropped. */
function htmlText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(script|style|title)[\s\S]*?<\/\1>/gi, '')
      .replace(
        /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi,
        (_, level: string, text: string) => `\n\n${'#'.repeat(Number(level))} ${text.trim()}\n\n`,
      )
      .replace(/<\/(p|div|li|section|article)>|<br\s*\/?>/gi, '\n\n')
      .replace(/<[^>]+>/g, ''),
  )
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const isPdf = (name: string, mime: string): boolean =>
  mime === 'application/pdf' || extensionOf(name) === 'pdf';
const isDocx = (name: string, mime: string): boolean =>
  mime === DOCX_MIME || extensionOf(name) === 'docx';
const isHtml = (name: string, mime: string): boolean =>
  mime === 'text/html' || ['html', 'htm'].includes(extensionOf(name));

const PDF_FAILURE = 'Could not parse PDF: the file is damaged or not a PDF.';
const DOCX_FAILURE = 'Could not parse DOCX: the file is damaged or not a Word document.';

/**
 * The text of an uploaded file, or why there is none, in words a user can act on (FR-RAG-003).
 * A name containing "corrupt" always fails, so a test can produce the failure with any bytes.
 */
export function parseDocument(name: string, mime: string, bytes: Uint8Array): ParseResult {
  const corrupt = /corrupt/i.test(name);
  if (isPdf(name, mime)) {
    const header = new TextDecoder('latin1').decode(bytes.subarray(0, 5));
    if (corrupt || header !== '%PDF-') return { ok: false, reason: PDF_FAILURE };
    const text = pdfText(bytes);
    return text.trim() === ''
      ? { ok: false, reason: 'Could not parse PDF: it has no text layer (is it a scan?).' }
      : { ok: true, text };
  }
  if (isDocx(name, mime)) {
    const text = corrupt ? undefined : docxText(bytes);
    if (text === undefined) return { ok: false, reason: DOCX_FAILURE };
    return text.trim() === ''
      ? { ok: false, reason: `${name} has no text to index.` }
      : { ok: true, text };
  }
  if (corrupt) return { ok: false, reason: `Could not parse ${name}: the file is damaged.` };
  if (/^(image|audio|video)\//.test(mime) || mime === 'application/zip') {
    return { ok: false, reason: `Files of type "${mime}" have no text to index.` };
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, reason: `Could not read ${name}: it is not UTF-8 text.` };
  }
  if (isHtml(name, mime)) text = htmlText(text);
  return text.trim() === ''
    ? { ok: false, reason: `${name} has no text to index.` }
    : { ok: true, text };
}

/* -------------------------------------------------------------------------- */
/* Chunking (§2.1)                                                             */
/* -------------------------------------------------------------------------- */

/** The mock's token count: about four characters a token, never zero. */
export const tokensOf = (text: string): number => Math.max(1, Math.ceil(text.length / 4));

interface Block {
  text: string;
  headings: string[];
  firstLine: number;
  lastLine: number;
}

/** Paragraphs under their heading path (prose), or top-level declarations (code). */
function blocksOf(name: string, text: string): Block[] {
  const lines = text.split('\n');
  const blocks: Block[] = [];

  if (isCodeDocument(name)) {
    // split on top-level function/class boundaries; a leading doc comment stays with what follows
    const boundary = /^(export\s+)?(default\s+)?(async\s+)?(function|class|interface|def|const)\b/;
    const comment = /^\s*(\/\*\*|\*|\/\/|#)/;
    let start = 0;
    const cut = (end: number) => {
      let last = end - 1;
      while (last > start && lines[last]!.trim() === '') last -= 1;
      const body = lines
        .slice(start, last + 1)
        .join('\n')
        .trim();
      if (body !== '') blocks.push({ text: body, headings: [], firstLine: start, lastLine: last });
      start = end;
    };
    lines.forEach((line, index) => {
      if (!boundary.test(line) || index === start) return;
      // a doc comment right above a declaration belongs to it
      let end = index;
      while (end > start && comment.test(lines[end - 1]!)) end -= 1;
      if (end > start) cut(end);
    });
    cut(lines.length);
    return blocks;
  }

  let current: Block | undefined;
  const flush = () => {
    if (current !== undefined && current.text.trim() !== '') {
      blocks.push({ ...current, text: current.text.trim() });
    }
    current = undefined;
  };
  const path: string[] = [];
  lines.forEach((line, index) => {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line.trim());
    if (heading) {
      flush();
      const depth = heading[1]!.length;
      path.splice(depth - 1);
      path[depth - 1] = heading[2]!.trim();
      return;
    }
    if (line.trim() === '') {
      flush();
      return;
    }
    if (current === undefined) {
      current = { text: '', headings: path.filter(Boolean), firstLine: index, lastLine: index };
    }
    current.text += `${current.text === '' ? '' : '\n'}${line}`;
    current.lastLine = index;
  });
  flush();
  return blocks;
}

/**
 * Split a document into chunks of at most `chunkSize` tokens: headings first, then paragraphs (or
 * top-level declarations for code), carrying up to `chunkOverlap` tokens of the previous paragraph
 * into the next chunk of the same section. `source` names the heading, or the line range above it.
 */
export function chunkDocument(
  doc: Pick<KbDocument, 'id' | 'knowledgeBaseId' | 'name'>,
  text: string,
  settings: Pick<KnowledgeBase, 'chunkSize' | 'chunkOverlap'>,
): KbChunk[] {
  const chunks: KbChunk[] = [];
  const push = (blocks: Block[]) => {
    const body = blocks.map((block) => block.text).join('\n\n');
    const first = blocks[0]!;
    const last = blocks[blocks.length - 1]!;
    const heading = first.headings[first.headings.length - 1];
    const lines = `lines ${first.firstLine + 1}-${last.lastLine + 1}`;
    chunks.push({
      id: newId(),
      documentId: doc.id,
      knowledgeBaseId: doc.knowledgeBaseId,
      ordinal: chunks.length,
      text: body,
      tokens: tokensOf(body),
      source: `${doc.name}#${heading ?? lines}`,
      headings: first.headings,
    });
  };

  // a block longer than a whole chunk is cut into chunk-sized word runs first
  const maxChars = settings.chunkSize * 4;
  const blocks = blocksOf(doc.name, text).flatMap((block): Block[] => {
    if (tokensOf(block.text) <= settings.chunkSize) return [block];
    const pieces: Block[] = [];
    let piece = '';
    for (const word of block.text.split(/\s+/)) {
      if (piece.length + word.length + 1 > maxChars && piece !== '') {
        pieces.push({ ...block, text: piece });
        piece = '';
      }
      piece += `${piece === '' ? '' : ' '}${word}`;
    }
    if (piece !== '') pieces.push({ ...block, text: piece });
    return pieces;
  });

  let group: Block[] = [];
  // a declaration is a chunk of its own; prose packs paragraphs of one section together
  const code = isCodeDocument(doc.name);
  const sameSection = (a: Block, b: Block) =>
    !code && a.headings.join('/') === b.headings.join('/');
  for (const block of blocks) {
    const size = group.reduce((sum, member) => sum + tokensOf(member.text), 0);
    const fits = size + tokensOf(block.text) <= settings.chunkSize;
    if (group.length > 0 && (!sameSection(group[0]!, block) || !fits)) {
      push(group);
      const tail = group[group.length - 1]!;
      group =
        !fits && sameSection(tail, block) && tokensOf(tail.text) <= settings.chunkOverlap
          ? [tail]
          : [];
    }
    group.push(block);
  }
  if (group.length > 0) push(group);
  return chunks;
}

/* -------------------------------------------------------------------------- */
/* Search (§2.1, FR-RAG-004)                                                   */
/* -------------------------------------------------------------------------- */

/** FTS5-ish terms: lowercase words, a hyphenated token kept whole so a rare term matches exactly. */
const keywordTerms = (text: string): string[] =>
  text.toLowerCase().match(/[a-z0-9]+(?:[-_][a-z0-9]+)*/g) ?? [];

const STOPWORDS = new Set(
  (
    'a an and are as at be by do does each every for from has have how in into is it its many ' +
    'much of on or our per the their there this to was what when where which who why will with ' +
    'you your'
  ).split(' '),
);

/** What the toy embedder "knows": a few synonyms, so a paraphrase lands near its source. */
const SYNONYMS: Record<string, string> = {
  vacation: 'leave',
  holiday: 'leave',
  pto: 'leave',
  worker: 'employee',
  staff: 'employee',
  personnel: 'employee',
  get: 'receive',
  gets: 'receive',
  given: 'receive',
  annual: 'year',
  yearly: 'year',
  outage: 'incident',
  breakdown: 'incident',
  credential: 'password',
  change: 'rotate',
  laptop: 'computer',
  machine: 'computer',
  backoff: 'retry',
  database: 'sqlite',
};

const stem = (word: string): string =>
  word.length > 4 && word.endsWith('ies')
    ? `${word.slice(0, -3)}y`
    : word.length > 4 && word.endsWith('ing')
      ? word.slice(0, -3)
      : word.length > 3 && word.endsWith('s') && !word.endsWith('ss')
        ? word.slice(0, -1)
        : word;

/** The bag of meanings the vector arm compares: stemmed, de-stopworded, synonyms folded. */
function meaningBag(text: string): Map<string, number> {
  const bag = new Map<string, number>();
  for (const raw of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (STOPWORDS.has(raw)) continue;
    const word = SYNONYMS[raw] ?? SYNONYMS[stem(raw)] ?? stem(raw);
    bag.set(word, (bag.get(word) ?? 0) + 1);
  }
  return bag;
}

function cosine(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  for (const [word, weight] of a) dot += weight * (b.get(word) ?? 0);
  if (dot === 0) return 0;
  const norm = (bag: Map<string, number>) =>
    Math.sqrt([...bag.values()].reduce((sum, w) => sum + w * w, 0));
  return dot / (norm(a) * norm(b));
}

/** Each arm keeps this many candidates before fusion. */
const ARM_DEPTH = 20;

function vectorRanking(chunks: readonly KbChunk[], query: string): string[] {
  const q = meaningBag(query);
  return chunks
    .map((chunk) => ({ id: chunk.id, score: cosine(q, meaningBag(chunk.text)) }))
    .filter((scored) => scored.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, ARM_DEPTH)
    .map((scored) => scored.id);
}

function keywordRanking(chunks: readonly KbChunk[], query: string): string[] {
  const terms = [...new Set(keywordTerms(query))].filter((term) => !STOPWORDS.has(term));
  const bags = chunks.map((chunk) => keywordTerms(chunk.text));
  // idf, so a rare term outweighs a common one, as bm25 would
  const idf = new Map(
    terms.map((term) => {
      const holding = bags.filter((bag) => bag.includes(term)).length;
      return [term, Math.log(1 + chunks.length / (1 + holding))];
    }),
  );
  return chunks
    .map((chunk, i) => ({
      id: chunk.id,
      score: terms.reduce(
        (sum, term) => sum + bags[i]!.filter((t) => t === term).length * (idf.get(term) ?? 0),
        0,
      ),
    }))
    .filter((scored) => scored.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, ARM_DEPTH)
    .map((scored) => scored.id);
}

/** The best `k` chunks of these, fused by reciprocal rank (§2.1, D231). */
export function searchChunks(
  chunks: readonly KbChunk[],
  query: string,
  k: number,
  mode: SearchMode,
): SearchHit[] {
  const vector = mode === 'keyword' ? [] : vectorRanking(chunks, query);
  const keyword = mode === 'vector' ? [] : keywordRanking(chunks, query);
  const byId = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  return fuseRankings(vector, keyword)
    .slice(0, k)
    .map((ranked) => {
      const chunk = byId.get(ranked.chunkId)!;
      return {
        chunkId: chunk.id,
        documentId: chunk.documentId,
        text: chunk.text,
        score: ranked.score,
        source: chunk.source,
        via: ranked.via,
      };
    });
}

/** `POST /knowledge-bases/:id/query` over the base's indexed chunks. */
export function searchKnowledgeBase(
  db: MockDb,
  knowledgeBaseId: string,
  request: { query: string; k: number; mode: SearchMode },
): SearchResponse {
  const started = Date.now();
  const hits = searchChunks(db.kbChunksOf(knowledgeBaseId), request.query, request.k, request.mode);
  return { hits, tookMs: Math.max(0, Date.now() - started) };
}

/* -------------------------------------------------------------------------- */
/* Context guardrail: hidden instructions (§2.3, FR-GRD-004)                   */
/* -------------------------------------------------------------------------- */

/**
 * Strip §2.3's hidden-instruction patterns from untrusted text, and name what was stripped — the
 * types only, never the values (D232).
 */
export function stripHiddenInstructions(text: string): {
  text: string;
  stripped: HiddenInstructionType[];
} {
  const stripped = new Set<HiddenInstructionType>();
  const strip = (pattern: RegExp, type: HiddenInstructionType, input: string): string =>
    input.replace(pattern, () => {
      stripped.add(type);
      return '';
    });
  let out = strip(/<!--[\s\S]*?-->/g, 'html_comment', text);
  out = strip(/^\s*\[\/\/\]:\s*#.*$/gm, 'markdown_comment', out);
  out = strip(/[\u200B-\u200D\u2060\uFEFF]/g, 'zero_width', out);
  out = strip(
    /[^.!?\n]*\b(ignore|disregard|forget)\b[^.!?\n]*\b(previous|prior|above|earlier)\b[^.!?\n]*\binstructions?\b[^.!?\n]*[.!?]?/gi,
    'instruction_override',
    out,
  );
  out = strip(/[A-Za-z0-9+/]{200,}={0,2}/g, 'base64_payload', out);
  return { text: out.replace(/[ \t]{2,}/g, ' ').trim(), stripped: [...stripped] };
}

/* -------------------------------------------------------------------------- */
/* Ingestion (FR-RAG-002/003, Arch §21.3)                                      */
/* -------------------------------------------------------------------------- */

/** How long each ingestion stage takes, in ms (a knob, like the run pace — D200). */
let ingestPace = 150;
export function setIngestPace(ms: number): void {
  ingestPace = Math.max(0, ms);
}
export function currentIngestPace(): number {
  return ingestPace;
}

/** Fail the next document at `parsing` whatever its bytes — the `ingest-failed` story's knob. */
let failNext = false;
export function failNextIngest(on = true): void {
  failNext = on;
}

/** A base's counts follow its documents and chunks. */
export function refreshKbCounts(db: MockDb, knowledgeBaseId: string): void {
  db.updateKnowledgeBase(knowledgeBaseId, {
    documentCount: db.kbDocumentsOf(knowledgeBaseId).length,
    chunkCount: db.kbChunksOf(knowledgeBaseId).length,
  });
}

function emitIngest(
  db: MockDb,
  doc: KbDocument,
  status: KbDocumentStatus,
  extra: { progress?: number; error?: string } = {},
): void {
  db.emit({
    type: 'kb.ingest',
    scope: 'engine',
    payload: {
      knowledgeBaseId: doc.knowledgeBaseId,
      documentId: doc.id,
      status,
      ...(extra.progress === undefined ? {} : { progress: extra.progress }),
      ...(extra.error === undefined ? {} : { error: extra.error }),
    },
  });
}

/**
 * Parse and chunk a document now — what the staged playback does one stage at a time, and what a
 * seed uses when it wants a base that is already ready.
 */
export function prepareDocument(
  db: MockDb,
  doc: KbDocument,
  forceFail = false,
): { ok: true; chunks: KbChunk[] } | { ok: false; reason: string } {
  const kb = db.getKnowledgeBase(doc.knowledgeBaseId);
  const bytes = db.artifactBytes(doc.artifactId);
  if (kb === undefined) return { ok: false, reason: 'The knowledge base no longer exists.' };
  if (bytes === undefined) return { ok: false, reason: `The file behind ${doc.name} is gone.` };
  if (forceFail) return { ok: false, reason: `Could not parse ${doc.name}: the file is damaged.` };
  const parsed = parseDocument(doc.name, doc.mime, bytes);
  if (!parsed.ok) return parsed;
  const chunks = chunkDocument(doc, parsed.text, kb);
  return chunks.length === 0
    ? { ok: false, reason: `${doc.name} has no text to index.` }
    : { ok: true, chunks };
}

function finishReady(db: MockDb, doc: KbDocument, chunks: KbChunk[]): void {
  db.setKbChunks(doc.id, chunks);
  const ready = db.updateKbDocument(doc.id, {
    status: 'ready',
    chunkCount: chunks.length,
    ingestedAt: new Date().toISOString(),
  });
  if (ready !== undefined) delete ready.error;
  refreshKbCounts(db, doc.knowledgeBaseId);
  emitIngest(db, doc, 'ready', { progress: 1 });
}

function finishFailed(db: MockDb, doc: KbDocument, reason: string): void {
  db.setKbChunks(doc.id, []);
  db.updateKbDocument(doc.id, { status: 'failed', chunkCount: 0, error: reason });
  refreshKbCounts(db, doc.knowledgeBaseId);
  emitIngest(db, doc, 'failed', { error: reason });
}

/** Ingest synchronously, straight to `ready` or `failed` — seeds and templates use this. */
export function ingestNow(db: MockDb, doc: KbDocument): KbDocument {
  const prepared = prepareDocument(db, doc);
  if (prepared.ok) finishReady(db, doc, prepared.chunks);
  else finishFailed(db, doc, prepared.reason);
  return db.getKbDocument(doc.id) ?? doc;
}

/** Each document's next stage, so a delete or a reindex can stop exactly that document. */
const ingestions = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Run a document's ingestion, one `kb.ingest` per stage at the ingest pace: `parsing`, `chunking`,
 * `embedding` with its progress climbing, then `ready` (or `failed` at `parsing`, with the reason).
 * Keyed by document, so one document failing or being deleted never touches its siblings.
 *
 * Each stage arms the next only once it has played. Arming them all up front, as the run playback
 * does, let a loaded timer queue fire `ready` before the last `embedding` stage, which then wrote
 * the document back to `embedding` for good.
 */
export function startIngestion(db: MockDb, documentId: string): void {
  cancelIngestion(documentId);
  const forceFail = failNext;
  failNext = false;
  let chunks: KbChunk[] = [];

  const progressStages = [
    ['chunking', 0.3],
    ['embedding', 0.5],
    ['embedding', 0.7],
    ['embedding', 0.9],
  ] as const;

  /** Each answers whether the pipeline goes on. */
  const stages: ((doc: KbDocument) => boolean)[] = [
    (doc) => {
      db.updateKbDocument(documentId, { status: 'parsing' });
      emitIngest(db, doc, 'parsing', { progress: 0.1 });
      const prepared = prepareDocument(db, doc, forceFail);
      if (!prepared.ok) {
        finishFailed(db, doc, prepared.reason);
        return false;
      }
      chunks = prepared.chunks;
      return true;
    },
    ...progressStages.map(([status, progress]) => (doc: KbDocument) => {
      db.updateKbDocument(documentId, { status });
      emitIngest(db, doc, status, { progress });
      return true;
    }),
    (doc) => {
      finishReady(db, doc, chunks);
      return false;
    },
  ];

  const next = (index: number): void => {
    ingestions.set(
      documentId,
      setTimeout(() => {
        ingestions.delete(documentId);
        // a deleted document stops here, whatever stage it had reached
        const doc = db.getKbDocument(documentId);
        if (doc === undefined) return;
        if (stages[index]!(doc) && index + 1 < stages.length) next(index + 1);
      }, ingestPace),
    );
  };
  next(0);
}

/** Stop a document's ingestion — on delete, or before a reindex restarts it. */
export function cancelIngestion(documentId: string): void {
  const timer = ingestions.get(documentId);
  if (timer !== undefined) clearTimeout(timer);
  ingestions.delete(documentId);
}

/** Every ingestion stopped: what a test calls between cases so none leaks into the next. */
export function stopAllIngestion(): void {
  for (const documentId of [...ingestions.keys()]) cancelIngestion(documentId);
}

/** A new `pending` document row for this artifact, announced (§2.9: 202, queued). */
export function addDocument(
  db: MockDb,
  knowledgeBaseId: string,
  artifact: { id: string; name: string; mime: string; size: number },
): KbDocument {
  const doc: KbDocument = {
    id: newId(),
    knowledgeBaseId,
    artifactId: artifact.id,
    name: artifact.name,
    mime: artifact.mime,
    size: artifact.size,
    status: 'pending',
    chunkCount: 0,
    createdAt: new Date().toISOString(),
  };
  db.addKbDocument(doc);
  refreshKbCounts(db, knowledgeBaseId);
  emitIngest(db, doc, 'pending', { progress: 0 });
  return doc;
}

/* -------------------------------------------------------------------------- */
/* Retrieval for a run (§2.4, FR-RAG-005..007)                                 */
/* -------------------------------------------------------------------------- */

/** An agent's implicit retrieval: k = 5 per attached base, best first over all of them. */
export function retrieveForAgent(
  db: MockDb,
  knowledgeBaseIds: readonly string[],
  query: string,
  k = 5,
): SearchHit[] {
  return knowledgeBaseIds
    .flatMap((id) => searchChunks(db.kbChunksOf(id), query, k, 'hybrid'))
    .sort((a, b) => b.score - a.score);
}
