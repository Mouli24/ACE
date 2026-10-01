import {
  isKbDocumentSettled,
  type Id,
  type KbDocument,
  type KbDocumentStatus,
  type KbIngestPayload,
  type ServerFrame,
} from '@ace/contracts';

/**
 * The ingestion counterpart of `RunEventBuffer` and `ThreadEventBuffer` (round 5 §2.8, FR-RAG-003).
 * It folds `kb.ingest` frames — engine scope, persisted (D230) — into the latest stage of every
 * document, so a knowledge-base screen can show a progress bar per row without refetching.
 *
 * Every `kb.ingest` frame carries a `seq`, so a `resume` replay is idempotent, and an older frame
 * replayed after a newer one never moves a document backwards.
 */
export interface IngestProgress {
  status: KbDocumentStatus;
  /** The share of the whole pipeline done, 0..1; absent when the frame did not say. */
  progress?: number;
  /** Why ingestion failed; set only on `failed`. */
  error?: string;
  /** The seq of the frame this came from. */
  seq: number;
}

export interface IngestProgressView {
  /** The knowledge base this buffer keeps, when it was given one. */
  knowledgeBaseId: Id | undefined;
  /** The highest seq folded in; what `resume { afterSeq }` should ask from. */
  lastSeq: number;
  /** The latest stage of each document seen, by document id. */
  byDocument: Record<Id, IngestProgress>;
  /** `true` once the document has reached `ready` or `failed`; `false` while unseen or in flight. */
  settled: (documentId: Id) => boolean;
}

export class IngestProgressBuffer {
  private readonly knowledgeBaseId: Id | undefined;
  private lastSeq = -1;
  private readonly seen = new Set<number>();
  private readonly byDocument = new Map<Id, IngestProgress>();

  /** Without a base id the buffer keeps every base's documents — one socket, one screen. */
  constructor(knowledgeBaseId?: Id) {
    this.knowledgeBaseId = knowledgeBaseId;
  }

  /** Fold one frame in. Non-ingest frames, other bases' frames, and replays are ignored. */
  apply(frame: ServerFrame): void {
    if (frame.type !== 'kb.ingest') return;
    const { payload, seq } = frame;
    if (this.knowledgeBaseId !== undefined && payload.knowledgeBaseId !== this.knowledgeBaseId) {
      return;
    }
    if (this.seen.has(seq)) return;
    this.seen.add(seq);
    if (seq > this.lastSeq) this.lastSeq = seq;

    const current = this.byDocument.get(payload.documentId);
    if (current !== undefined && current.seq > seq) return;

    this.byDocument.set(payload.documentId, {
      status: payload.status,
      ...(payload.progress === undefined ? {} : { progress: payload.progress }),
      ...(payload.error === undefined ? {} : { error: payload.error }),
      seq,
    });
  }

  /** Forget everything; the next screen starts from nothing. */
  reset(): void {
    this.lastSeq = -1;
    this.seen.clear();
    this.byDocument.clear();
  }

  get view(): IngestProgressView {
    const byDocument: Record<Id, IngestProgress> = {};
    for (const [id, progress] of this.byDocument) byDocument[id] = { ...progress };
    return {
      knowledgeBaseId: this.knowledgeBaseId,
      lastSeq: this.lastSeq,
      byDocument,
      settled: (documentId) => {
        const progress = byDocument[documentId];
        return progress !== undefined && isKbDocumentSettled(progress.status);
      },
    };
  }
}

/**
 * The `KbDocument` a cached list should hold after a `kb.ingest` frame: the frame's status, and its
 * reason when it failed — a stale reason is dropped once the document moves on (a reindex). A frame
 * for another document answers the same object, so a cache updater can map over a list and keep
 * referential equality for every row it did not touch.
 */
export function applyKbIngest(doc: KbDocument, payload: KbIngestPayload): KbDocument {
  if (payload.documentId !== doc.id) return doc;
  const { error: _previous, ...rest } = doc;
  return {
    ...rest,
    status: payload.status,
    ...(payload.error === undefined ? {} : { error: payload.error }),
  };
}
