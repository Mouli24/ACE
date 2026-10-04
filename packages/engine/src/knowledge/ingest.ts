import type {
  Id,
  KbChunk,
  KbDocument,
  KbDocumentStatus,
  KbIngestPayload,
  Timestamp,
} from '@ace/contracts';

import type { EventBus } from '../events/index.js';
import { newId } from '../ids.js';
import type { Logger } from '../logging/index.js';
import type { Queue, Repository, Scope } from '../ports/index.js';
import type {
  ChunkKind,
  Chunker,
  ContextTextCheck,
  DocumentParser,
  EmbedderFor,
  ParsedHeading,
  KbChunkRepository,
  KbDocumentRepository,
  KnowledgeBaseRepository,
} from '../ports/knowledge.js';

/**
 * The ingestion pipeline (round 5 §2.1, FR-RAG-002, FR-RAG-003, FR-RAG-009, Arch §21.3).
 *
 * One queued job is one document. The worker runs them one at a time: parse, PII check, chunk,
 * embed, write — announcing a `kb.ingest` event at every stage — and a failure anywhere marks only
 * that document `failed`, so its siblings still reach `ready` (TC-RAG-003).
 */

/** One unit of queued work. */
export interface IngestJob {
  knowledgeBaseId: Id;
  documentId: Id;
}

/** Share of the whole pipeline done once a document has entered each stage (Arch §21.3). */
export const INGEST_PROGRESS = {
  pending: 0,
  parsing: 0.1,
  chunking: 0.3,
  embedding: 0.6,
  ready: 1,
} as const;

/** The repositories ingestion needs; they are optional on the `Repository` port. */
export interface KnowledgeRepositories {
  knowledgeBases: KnowledgeBaseRepository;
  kbDocuments: KbDocumentRepository;
  kbChunks: KbChunkRepository;
}

/** Fails clearly when the adapter has no round 5 knowledge storage. */
export function knowledgeRepositories(repository: Repository): KnowledgeRepositories {
  const { knowledgeBases, kbDocuments, kbChunks } = repository;
  if (knowledgeBases === undefined || kbDocuments === undefined || kbChunks === undefined) {
    throw new Error('The repository has no knowledge-base storage (round 5).');
  }
  return { knowledgeBases, kbDocuments, kbChunks };
}

/** Announces one stage of one document on the engine subscription (no workflow, no run — D230). */
export async function emitIngest(bus: EventBus, payload: KbIngestPayload): Promise<void> {
  await bus.emit({ type: 'kb.ingest', payload });
}

export interface IngestionWorkerDeps {
  repository: Repository;
  scope: Scope;
  queue: Queue<IngestJob>;
  bus: EventBus;
  parser: DocumentParser;
  chunker: Chunker;
  embedderFor: EmbedderFor;
  /** The PII check over the document's full text, at the project's default policy (F6). */
  checkContextText: ContextTextCheck;
  /** Prose or code, from the document's media type and name. */
  chunkKindFor: (doc: { mime: string; name: string }) => ChunkKind;
  /** The uploaded file's bytes, or null when the artifact is gone. */
  readArtifact: (artifactId: Id) => Promise<{ bytes: Uint8Array } | null>;
  logger: Logger;
  now?: () => Timestamp;
  nextId?: () => Id;
  /** How often `start()` looks for queued work when nothing woke it. Default 500 ms. */
  pollMs?: number;
}

export interface IngestionWorker {
  /** Processes queued documents, one at a time, until the queue is empty. */
  drain(): Promise<void>;
  /** Begins polling the queue. Idempotent. */
  start(): void;
  /** Stops polling and waits for the document in flight. */
  stop(): Promise<void>;
  /** Asks a started worker to look at the queue now. */
  wake(): void;
}

/** Thrown inside the pipeline when the document was deleted under it; never reaches the user. */
class DocumentGoneError extends Error {
  override readonly name = 'DocumentGoneError';
}

const DEFAULT_POLL_MS = 500;

/**
 * Re-finds each heading in the sanitised text. Redaction changes lengths, so the parser's offsets
 * no longer point at their titles; a heading whose own title was redacted is dropped.
 */
function rebuildHeadings(headings: ParsedHeading[], text: string): ParsedHeading[] {
  const rebuilt: ParsedHeading[] = [];
  let cursor = 0;
  for (const heading of headings) {
    const offset = text.indexOf(heading.title, cursor);
    if (offset === -1) continue;
    rebuilt.push({ ...heading, offset });
    cursor = offset + heading.title.length;
  }
  return rebuilt;
}

export function createIngestionWorker(deps: IngestionWorkerDeps): IngestionWorker {
  const { scope, queue, bus } = deps;
  const repos = knowledgeRepositories(deps.repository);
  const now = deps.now ?? (() => new Date().toISOString());
  const nextId = deps.nextId ?? newId;

  /** Moves the document to a stage and says so — unless it has been deleted meanwhile. */
  async function enter(job: IngestJob, status: KbDocumentStatus, progress: number): Promise<void> {
    const updated = await repos.kbDocuments.update(scope, job.documentId, { status });
    if (updated === null) throw new DocumentGoneError(job.documentId);
    await emitIngest(bus, {
      knowledgeBaseId: job.knowledgeBaseId,
      documentId: job.documentId,
      status,
      progress,
    });
  }

  async function ingest(job: IngestJob, doc: KbDocument): Promise<void> {
    const kb = await repos.knowledgeBases.get(scope, job.knowledgeBaseId);
    if (kb === null) throw new DocumentGoneError(job.documentId);

    await enter(job, 'parsing', INGEST_PROGRESS.parsing);
    const artifact = await deps.readArtifact(doc.artifactId);
    if (artifact === null) throw new Error('The uploaded file is no longer available.');
    const parsed = await deps.parser.parse({
      bytes: artifact.bytes,
      mime: doc.mime,
      name: doc.name,
    });

    const checked = await deps.checkContextText({ projectId: kb.projectId, text: parsed.text });
    if (checked.blocked !== undefined) {
      await fail(job, checked.blocked, checked.verdicts);
      return;
    }

    await enter(job, 'chunking', INGEST_PROGRESS.chunking);
    const drafts = deps.chunker.chunk({
      document: {
        text: checked.text,
        headings:
          checked.text === parsed.text
            ? parsed.headings
            : rebuildHeadings(parsed.headings, checked.text),
      },
      documentName: doc.name,
      kind: deps.chunkKindFor({ mime: doc.mime, name: doc.name }),
      chunkSize: kb.chunkSize,
      chunkOverlap: kb.chunkOverlap,
    });

    await enter(job, 'embedding', INGEST_PROGRESS.embedding);
    const embedder = await deps.embedderFor(kb);
    const embeddings = drafts.length === 0 ? [] : await embedder.embed(drafts.map((d) => d.text));
    if (embeddings.length !== drafts.length) {
      throw new Error('The embedder returned the wrong number of vectors.');
    }

    // A document deleted while it was being embedded gets no chunks (Review Focus 2).
    if ((await repos.kbDocuments.get(scope, job.documentId)) === null) {
      throw new DocumentGoneError(job.documentId);
    }
    const chunks: KbChunk[] = drafts.map((draft) => ({
      id: nextId(),
      documentId: job.documentId,
      knowledgeBaseId: job.knowledgeBaseId,
      ordinal: draft.ordinal,
      text: draft.text,
      tokens: draft.tokens,
      source: draft.source,
      headings: draft.headings,
    }));
    await repos.kbChunks.replaceForDocument(scope, job.documentId, chunks, embeddings);

    // The delete may have landed between the check and the write: take the chunks back out.
    if ((await repos.kbDocuments.get(scope, job.documentId)) === null) {
      await repos.kbDocuments.delete(scope, job.documentId);
      throw new DocumentGoneError(job.documentId);
    }

    const ready = await repos.kbDocuments.update(scope, job.documentId, {
      status: 'ready',
      chunkCount: chunks.length,
      ingestedAt: now(),
      verdicts: checked.verdicts,
      error: null,
    });
    if (ready === null) {
      await repos.kbDocuments.delete(scope, job.documentId);
      throw new DocumentGoneError(job.documentId);
    }
    // The document is ready now; a failed announcement must not undo that.
    try {
      await emitIngest(bus, {
        knowledgeBaseId: job.knowledgeBaseId,
        documentId: job.documentId,
        status: 'ready',
        progress: INGEST_PROGRESS.ready,
      });
    } catch (error) {
      deps.logger.warn(
        {
          subsystem: 'knowledge',
          documentId: job.documentId,
          reason: error instanceof Error ? error.message : String(error),
        },
        'could not announce a ready document',
      );
    }
  }

  async function fail(
    job: IngestJob,
    error: string,
    verdicts?: KbDocument['verdicts'],
  ): Promise<void> {
    const reason = error === '' ? 'Indexing failed.' : error;
    const updated = await repos.kbDocuments.update(scope, job.documentId, {
      status: 'failed',
      error: reason,
      ...(verdicts === undefined || verdicts.length === 0 ? {} : { verdicts }),
    });
    if (updated === null) return;
    // A failed document must never keep serving the content of an earlier ingestion.
    await repos.kbChunks.replaceForDocument(scope, job.documentId, [], []);
    await emitIngest(bus, {
      knowledgeBaseId: job.knowledgeBaseId,
      documentId: job.documentId,
      status: 'failed',
      error: reason,
    });
  }

  async function process(job: IngestJob): Promise<void> {
    const doc = await repos.kbDocuments.get(scope, job.documentId);
    if (doc === null) return;
    try {
      await ingest(job, doc);
    } catch (error) {
      if (error instanceof DocumentGoneError) return;
      const message = error instanceof Error ? error.message : String(error);
      await fail(
        job,
        error instanceof Error && error.name === 'ParseError'
          ? message
          : `Indexing failed: ${message}`,
      );
    }
  }

  let inFlight: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  /** One drain at a time: a second caller joins the one already running. */
  function drain(): Promise<void> {
    if (inFlight !== null) return inFlight;
    const run = (async () => {
      for (;;) {
        const job = await queue.dequeue(scope);
        if (job === null) return;
        try {
          await process(job);
        } catch (error) {
          // Nothing one job throws may stop the documents queued behind it.
          deps.logger.error(
            {
              subsystem: 'knowledge',
              documentId: job.documentId,
              reason: error instanceof Error ? error.message : String(error),
            },
            'ingestion job failed unexpectedly',
          );
        }
      }
    })().finally(() => {
      inFlight = null;
    });
    inFlight = run;
    return run;
  }

  /** A polling or wake-up drain must never leave an unhandled rejection behind. */
  function kick(): void {
    drain().catch(() => undefined);
  }

  return {
    drain,
    start() {
      if (timer !== null) return;
      timer = setInterval(kick, deps.pollMs ?? DEFAULT_POLL_MS);
      kick();
    },
    async stop() {
      if (timer !== null) clearInterval(timer);
      timer = null;
      await inFlight?.catch(() => undefined);
    },
    wake() {
      if (timer !== null) kick();
    },
  };
}
