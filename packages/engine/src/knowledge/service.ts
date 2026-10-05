import type {
  AddKbDocumentRequest,
  CreateKnowledgeBaseRequest,
  Id,
  KbDocument,
  KnowledgeBase,
  Node,
  Timestamp,
  UpdateKnowledgeBaseRequest,
} from '@ace/contracts';

import type { EventBus } from '../events/index.js';
import { notFound, validationFailed } from '../gateway/errors.js';
import { newId } from '../ids.js';
import type { ProviderAdapter, Queue, Repository, Scope } from '../ports/index.js';
import { emitIngest, INGEST_PROGRESS, knowledgeRepositories, type IngestJob } from './ingest.js';

/**
 * The knowledge-base service (round 5 §2.1, FR-RAG-001, FR-RAG-002, FR-RAG-009).
 *
 * Bases, their documents, and the queue the ingestion worker drains. Parsing, chunking and
 * embedding are the worker's (`ingest.ts`); this service only records what the user asked for and
 * queues the work, so every call answers at once and `kb.ingest` reports the rest.
 */
export interface KnowledgeService {
  /** 404 for an unknown project; the embedding provider must exist and support `embed` (validation_failed). */
  create(projectId: Id, body: CreateKnowledgeBaseRequest): Promise<KnowledgeBase>;
  /** 404 for an unknown project, as `/projects/:id/workflows` is. */
  list(projectId: Id): Promise<KnowledgeBase[]>;
  get(id: Id): Promise<KnowledgeBase>;
  /** Checks the overlap against the stored size when a patch names only one of the two (D235). */
  update(id: Id, patch: UpdateKnowledgeBaseRequest): Promise<KnowledgeBase>;
  remove(id: Id): Promise<void>;
  /** The `pending` document, already queued (the route answers 202). */
  addDocument(kbId: Id, body: AddKbDocumentRequest): Promise<KbDocument>;
  listDocuments(kbId: Id): Promise<KbDocument[]>;
  removeDocument(docId: Id): Promise<void>;
  /** Re-queues every document of the base, with the base's current chunk settings (FR-RAG-009). */
  reindex(kbId: Id): Promise<void>;
  /** F7: documents interrupted mid-pipeline go back to `pending` and are queued; returns how many. */
  recover(): Promise<number>;
}

/**
 * Whether a node reads this knowledge base: an agent attached to it, or a Retrieval node searching
 * it (round 5 §2.4). Both repositories' `nodes.listByKnowledgeBase` answer by it (FR-PRV-005).
 */
export function namesKnowledgeBase(node: Node, knowledgeBaseId: Id): boolean {
  if (node.kind === 'agent') return (node.config.knowledgeBaseIds ?? []).includes(knowledgeBaseId);
  if (node.kind === 'retrieval') return node.config.knowledgeBaseId === knowledgeBaseId;
  return false;
}

export interface KnowledgeServiceDeps {
  repository: Repository;
  scope: Scope;
  /** Only the live adapter lookup is needed, to know a provider can embed. */
  providers: { adapterFor(id: Id): Promise<ProviderAdapter> };
  /** The uploaded file's row — name, media type and size are copied onto the document. */
  artifacts: { get(id: Id): Promise<{ name: string; mime: string; size: number } | null> };
  queue: Queue<IngestJob>;
  bus: EventBus;
  /** Called after work is queued so a running worker picks it up without waiting for its poll. */
  wake?: () => void;
  now?: () => Timestamp;
  nextId?: () => Id;
}

export function createKnowledgeService(deps: KnowledgeServiceDeps): KnowledgeService {
  const { repository, scope, queue, bus } = deps;
  const repos = knowledgeRepositories(repository);
  const now = deps.now ?? (() => new Date().toISOString());
  const nextId = deps.nextId ?? newId;

  async function load(id: Id): Promise<KnowledgeBase> {
    const kb = await repos.knowledgeBases.get(scope, id);
    if (kb === null) throw notFound(`Knowledge base ${id}`);
    return kb;
  }

  const refuse = (code: string, message: string) =>
    validationFailed(message, [{ severity: 'error', code, message }]);

  async function queueDocument(doc: KbDocument): Promise<void> {
    await queue.enqueue(scope, { knowledgeBaseId: doc.knowledgeBaseId, documentId: doc.id });
    await emitIngest(bus, {
      knowledgeBaseId: doc.knowledgeBaseId,
      documentId: doc.id,
      status: 'pending',
      progress: INGEST_PROGRESS.pending,
    });
  }

  /** A project's bases are a project's: an unknown one is 404, as its workflows are. */
  async function requireProject(projectId: Id): Promise<void> {
    if ((await repository.projects.get(scope, projectId)) === null) {
      throw notFound(`Project ${projectId}`);
    }
  }

  return {
    async create(projectId, body) {
      await requireProject(projectId);
      let adapter: ProviderAdapter;
      try {
        adapter = await deps.providers.adapterFor(body.embeddingProviderId);
      } catch {
        throw refuse(
          'embedding_provider_missing',
          `Embedding provider ${body.embeddingProviderId} was not found.`,
        );
      }
      if (typeof adapter.embed !== 'function') {
        throw refuse(
          'embedding_unsupported',
          'This provider cannot create embeddings. Choose one that supports embeddings.',
        );
      }

      const at = now();
      return repos.knowledgeBases.insert(scope, {
        id: nextId(),
        projectId,
        name: body.name,
        embeddingProviderId: body.embeddingProviderId,
        embeddingModelId: body.embeddingModelId,
        chunkSize: body.chunkSize,
        chunkOverlap: body.chunkOverlap,
        documentCount: 0,
        chunkCount: 0,
        createdAt: at,
        updatedAt: at,
      });
    },

    async list(projectId) {
      await requireProject(projectId);
      return repos.knowledgeBases.listByProject(scope, projectId);
    },

    get: load,

    async update(id, patch) {
      const kb = await load(id);
      const chunkSize = patch.chunkSize ?? kb.chunkSize;
      const chunkOverlap = patch.chunkOverlap ?? kb.chunkOverlap;
      if (chunkOverlap >= chunkSize) {
        throw refuse(
          'chunk_overlap_too_large',
          'Chunk overlap must be smaller than the chunk size.',
        );
      }
      const updated = await repos.knowledgeBases.update(scope, id, {
        ...(patch.name === undefined ? {} : { name: patch.name }),
        chunkSize,
        chunkOverlap,
        updatedAt: now(),
      });
      if (updated === null) throw notFound(`Knowledge base ${id}`);
      return updated;
    },

    async remove(id) {
      await load(id);
      await repos.knowledgeBases.delete(scope, id);
    },

    async addDocument(kbId, body) {
      await load(kbId);
      const artifact = await deps.artifacts.get(body.artifactId);
      if (artifact === null) throw notFound(`Artifact ${body.artifactId}`);

      const doc = await repos.kbDocuments.insert(scope, {
        id: nextId(),
        knowledgeBaseId: kbId,
        artifactId: body.artifactId,
        name: artifact.name,
        mime: artifact.mime,
        size: artifact.size,
        status: 'pending',
        chunkCount: 0,
        createdAt: now(),
      });
      await queueDocument(doc);
      deps.wake?.();
      return doc;
    },

    async listDocuments(kbId) {
      await load(kbId);
      return repos.kbDocuments.listByKnowledgeBase(scope, kbId);
    },

    async removeDocument(docId) {
      const doc = await repos.kbDocuments.get(scope, docId);
      if (doc === null) throw notFound(`Document ${docId}`);
      await repos.kbDocuments.delete(scope, docId);
    },

    async reindex(kbId) {
      await load(kbId);
      for (const doc of await repos.kbDocuments.listByKnowledgeBase(scope, kbId)) {
        const reset = await repos.kbDocuments.update(scope, doc.id, {
          status: 'pending',
          error: null,
        });
        if (reset !== null) await queueDocument(reset);
      }
      deps.wake?.();
    },

    async recover() {
      const unsettled = await repos.kbDocuments.listUnsettled(scope);
      for (const doc of unsettled) {
        const reset =
          doc.status === 'pending'
            ? doc
            : await repos.kbDocuments.update(scope, doc.id, { status: 'pending' });
        if (reset !== null) await queueDocument(reset);
      }
      if (unsettled.length > 0) deps.wake?.();
      return unsettled.length;
    },
  };
}
