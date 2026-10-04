import type { Artifact, KbChunk, KbIngestPayload, KnowledgeBase } from '@ace/contracts';

import { FakeRepository } from '../../__tests__/fake-repository.js';
import type { EmittedEvent, EventBus } from '../../events/index.js';
import { LOCAL_SCOPE, type ProviderAdapter, type Queue, type Scope } from '../../ports/index.js';
import type {
  Chunker,
  ContextTextCheck,
  DocumentParser,
  Embedder,
  EmbedderFor,
} from '../../ports/knowledge.js';
import { createLogger } from '../../logging/index.js';
import { createIngestionWorker, type IngestJob, type IngestionWorkerDeps } from '../ingest.js';
import {
  createKnowledgeService,
  type KnowledgeService,
  type KnowledgeServiceDeps,
} from '../service.js';

export const PROJECT_ID = '01PROJECT0000000000000000000';
export const PROVIDER_ID = '01PROVIDER000000000000000000';

class ParseError extends Error {
  override readonly name = 'ParseError';
}

export class ListQueue implements Queue<IngestJob> {
  readonly jobs: IngestJob[] = [];
  async enqueue(_scope: Scope, job: IngestJob): Promise<void> {
    this.jobs.push(job);
  }
  async dequeue(): Promise<IngestJob | null> {
    return this.jobs.shift() ?? null;
  }
  async size(): Promise<number> {
    return this.jobs.length;
  }
}

/** Records every emitted event; the only part of the bus the knowledge code touches. */
export class RecordingBus implements EventBus {
  readonly events: EmittedEvent[] = [];
  async emit(event: EmittedEvent) {
    this.events.push(event);
    return { seq: this.events.length, createdAt: '2026-01-01T00:00:00.000Z', ...event };
  }
  async emitTransient(): Promise<void> {}
  async subscribe() {
    return () => {};
  }
  ingest(): KbIngestPayload[] {
    return this.events
      .filter((e) => e.type === 'kb.ingest')
      .map((e) => e.payload as KbIngestPayload);
  }
}

/** Bytes starting "CORRUPT" fail to parse; otherwise the bytes are the text. */
export const fakeParser: DocumentParser = {
  async parse({ bytes }) {
    const text = new TextDecoder().decode(bytes);
    if (text.startsWith('CORRUPT')) throw new ParseError('The file is corrupt and cannot be read.');
    return { text, headings: [] };
  },
};

/** One chunk per blank-line-separated paragraph. */
export const fakeChunker: Chunker = {
  chunk({ document, documentName }) {
    return document.text
      .split('\n\n')
      .filter((p) => p.trim() !== '')
      .map((text, ordinal) => ({
        ordinal,
        text,
        tokens: Math.ceil(text.length / 4),
        source: `${documentName}#${ordinal}`,
        headings: [],
      }));
  },
};

export const fakeEmbedder: Embedder = {
  async embed(texts) {
    return texts.map((t) => [t.length, 1]);
  },
};

export const passThrough: ContextTextCheck = async ({ text }) => ({ text, verdicts: [] });

export interface Harness {
  repo: FakeRepository;
  bus: RecordingBus;
  queue: ListQueue;
  service: KnowledgeService;
  serviceDeps: KnowledgeServiceDeps;
  artifacts: Map<string, { artifact: Artifact; bytes: Uint8Array }>;
  worker: ReturnType<typeof createIngestionWorker>;
  workerDeps: IngestionWorkerDeps;
  /** Every chunk handed to `replaceForDocument`, in call order. */
  written: KbChunk[];
  /** Log records the worker wrote at warn or above. */
  logLines: string[];
  addFile(name: string, text: string): string;
  createKb(): Promise<KnowledgeBase>;
}

export interface HarnessOptions {
  embedder?: EmbedderFor;
  parser?: DocumentParser;
  check?: ContextTextCheck;
  /** `null` means the provider does not exist; an object without `embed` has no embeddings. */
  adapter?: Partial<ProviderAdapter> | null;
}

export async function makeHarness(options: HarnessOptions = {}): Promise<Harness> {
  const repo = new FakeRepository();
  const bus = new RecordingBus();
  const queue = new ListQueue();
  const artifacts = new Map<string, { artifact: Artifact; bytes: Uint8Array }>();
  await repo.projects.create(LOCAL_SCOPE, {
    id: PROJECT_ID,
    name: 'P',
    folderPath: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  let n = 0;
  const nextId = (): string => `01ID${String(++n).padStart(24, '0')}`;
  const adapter =
    options.adapter === undefined
      ? ({ type: 'mock', embed: fakeEmbedder.embed } as unknown as ProviderAdapter)
      : (options.adapter as ProviderAdapter | null);

  const serviceDeps: KnowledgeServiceDeps = {
    repository: repo,
    scope: LOCAL_SCOPE,
    providers: {
      adapterFor: async (id) => {
        if (adapter === null || id !== PROVIDER_ID) {
          throw new Error(`Provider ${id} was not found.`);
        }
        return adapter;
      },
    },
    artifacts: { get: async (id) => artifacts.get(id)?.artifact ?? null },
    queue,
    bus,
    nextId,
  };
  const logLines: string[] = [];
  const logger = createLogger({
    level: 'warn',
    destination: { write: (line: string) => void logLines.push(line) },
  });
  const workerDeps: IngestionWorkerDeps = {
    repository: repo,
    scope: LOCAL_SCOPE,
    queue,
    bus,
    parser: options.parser ?? fakeParser,
    chunker: fakeChunker,
    embedderFor: options.embedder ?? (async () => fakeEmbedder),
    checkContextText: options.check ?? passThrough,
    chunkKindFor: ({ name }) => (name.endsWith('.ts') ? 'code' : 'prose'),
    readArtifact: async (id) => artifacts.get(id) ?? null,
    nextId,
    logger,
  };
  const service = createKnowledgeService(serviceDeps);
  const written: KbChunk[] = [];
  const replace = repo.kbChunks.replaceForDocument.bind(repo.kbChunks);
  repo.kbChunks.replaceForDocument = async (scope, documentId, chunks, embeddings) => {
    written.push(...chunks);
    await replace(scope, documentId, chunks, embeddings);
  };
  return {
    repo,
    bus,
    queue,
    service,
    serviceDeps,
    artifacts,
    worker: createIngestionWorker(workerDeps),
    workerDeps,
    written,
    logLines,
    addFile(name, text) {
      const id = `01ART${String(artifacts.size + 1).padStart(23, '0')}`;
      const bytes = new TextEncoder().encode(text);
      artifacts.set(id, {
        bytes,
        artifact: {
          id,
          hash: 'a'.repeat(64),
          mime: 'text/plain',
          name,
          size: bytes.byteLength,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      });
      return id;
    },
    createKb: () =>
      service.create(PROJECT_ID, {
        name: 'KB',
        embeddingProviderId: PROVIDER_ID,
        embeddingModelId: 'mock-embed',
        chunkSize: 700,
        chunkOverlap: 90,
      }),
  };
}
