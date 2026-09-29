import { createHash } from 'node:crypto';

import {
  ArtifactNameSchema,
  ArtifactSchema,
  isAllowedUpload,
  maxUploadBytes,
  type Artifact,
  type Id,
  type Settings,
  type Timestamp,
} from '@ace/contracts';

import { newId } from '../ids.js';
import type { ArtifactRepository, BlobStore, Scope } from '../ports/index.js';
import { UnsupportedTypeError, UploadTooLargeError } from './errors.js';

export * from './errors.js';

/**
 * The artifact store (round 4 §2.1, §4 item 1, FR-MM-001/002/009, Arch §15.1, §15.4).
 *
 * One rule shapes the whole service: bytes never travel through the API's JSON (FR-MM-004, BR-02).
 * The bytes live in the content-addressed `BlobStore`, keyed by their sha256; the `Artifact` row —
 * hash, mime, name, size — lives in the `ArtifactRepository`. The service owns the *policy* around
 * those two ports: the size limit, the type allow-list, dedupe by hash, and the retention sweep.
 *
 * It is deliberately free of HTTP. `upload` takes bytes (or a byte stream) and metadata and throws
 * an {@link UploadTooLargeError} / {@link UnsupportedTypeError}; `content` returns bytes plus the
 * row. Multipart parsing, `ETag`, `Range` and `Content-Disposition` are the gateway's (Wave 3).
 */

/** How long an artifact survives after nothing references it (Arch §15.4: "unreferenced + 7 days"). */
export const ARTIFACT_RETENTION_DAYS = 7;

const RETENTION_MS = ARTIFACT_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/** The bytes an upload arrives as: a whole buffer, or an async stream of chunks (a Node `Readable`). */
export type UploadSource = Uint8Array | AsyncIterable<Uint8Array>;

/** What the caller knows about a file before it is stored. */
export interface UploadMeta {
  /** The browser-supplied media type; blank falls back to `application/octet-stream`. */
  mime: string;
  /** The original filename (1..255 chars, §2.1); its extension can decide the allow-list (D52). */
  name: string;
}

/** The bytes of one artifact plus the row that describes them — everything the gateway serves. */
export interface ArtifactContent {
  artifact: Artifact;
  bytes: Uint8Array;
}

/** Read-only settings access, for `maxUploadMb` (§2.1). Narrowed so the service cannot write them. */
export interface SettingsReader {
  get(scope: Scope): Promise<Settings>;
}

export interface ArtifactService {
  /**
   * Stores an upload and returns its `Artifact` (§2.1, FR-MM-001, FR-MM-002).
   *
   * The bytes are hashed as they stream, and the size limit is enforced *during* the stream — an
   * over-limit upload throws {@link UploadTooLargeError} without buffering the whole thing. A type
   * off the allow-list throws {@link UnsupportedTypeError} before any bytes are read. Identical
   * bytes already stored answer the existing row and nothing is written twice (dedupe, FR-MM-002).
   */
  upload(source: UploadSource, meta: UploadMeta): Promise<Artifact>;

  /** The row, or null (§2.4 `GET /artifacts/:id`). */
  get(id: Id): Promise<Artifact | null>;

  /**
   * The bytes plus the row (§2.4 `GET /artifacts/:id/content`, FR-MM-009), or null when either is
   * missing. The gateway sets `Content-Type`/`ETag`/`Content-Disposition` from the row and serves —
   * or slices — the bytes; the hash on the row lets a download prove it matches (TC-MM-008).
   */
  content(id: Id): Promise<ArtifactContent | null>;

  /**
   * Marks an artifact referenced *now* (or at `at`), moving the clock Arch §15.4 counts retention
   * from. Called when an Input node's config, a node run's output, or a chat attachment starts
   * pointing at it. Returns the updated row, or null when there is no such artifact.
   */
  markReferenced(id: Id, at?: Timestamp): Promise<Artifact | null>;

  /** `markReferenced` for a set of ids in one call — an Input config or a node output can name several. */
  markAllReferenced(ids: readonly Id[], at?: Timestamp): Promise<void>;

  /**
   * Deletes every artifact unreferenced for more than {@link ARTIFACT_RETENTION_DAYS} days and its
   * blob (Arch §15.4). `now` is injectable so a test can advance the clock rather than wait. The
   * row goes first, then the blob: an orphaned blob is harmless and self-heals on the next identical
   * upload, whereas a row pointing at a missing blob would surface as a broken download. Returns the
   * rows it removed.
   */
  sweepUnreferenced(now?: Timestamp): Promise<Artifact[]>;
}

export interface ArtifactServiceDeps {
  scope: Scope;
  artifacts: ArtifactRepository;
  blobs: BlobStore;
  settings: SettingsReader;
  /** Overridable so a test can pin `createdAt` and advance the retention clock (Arch §15.4). */
  clock?: () => Timestamp;
}

/** Joins the streamed chunks into one buffer of the exact size counted while streaming. */
function concat(chunks: readonly Uint8Array[], size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Reduces the source to its bytes, sha256 hex and size, throwing {@link UploadTooLargeError} the
 * moment the running size passes `maxBytes` — so a 10 GB stream against a 100 MB limit is refused
 * after ~100 MB, not after being fully read into memory.
 */
async function readWithLimit(
  source: UploadSource,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; hash: string; size: number }> {
  const digest = createHash('sha256');

  if (source instanceof Uint8Array) {
    if (source.byteLength > maxBytes) throw new UploadTooLargeError(maxBytes);
    digest.update(source);
    return { bytes: source, hash: digest.digest('hex'), size: source.byteLength };
  }

  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of source) {
    size += chunk.byteLength;
    if (size > maxBytes) throw new UploadTooLargeError(maxBytes);
    digest.update(chunk);
    chunks.push(chunk);
  }
  return { bytes: concat(chunks, size), hash: digest.digest('hex'), size };
}

export function createArtifactService(deps: ArtifactServiceDeps): ArtifactService {
  const { scope, artifacts, blobs, settings } = deps;
  const clock = deps.clock ?? ((): Timestamp => new Date().toISOString());

  return {
    async upload(source, meta) {
      // Type first: it is the cheapest check and refuses the file before a byte is read.
      if (!isAllowedUpload(meta)) throw new UnsupportedTypeError(meta.mime, meta.name);
      const name = ArtifactNameSchema.parse(meta.name);
      const mime = meta.mime.trim() === '' ? 'application/octet-stream' : meta.mime;

      const config = await settings.get(scope);
      const { bytes, hash, size } = await readWithLimit(source, maxUploadBytes(config.maxUploadMb));

      // Dedupe (FR-MM-002): identical bytes share one id, so the second upload writes nothing.
      const existing = await artifacts.getByHash(scope, hash);
      if (existing !== null) return existing;

      await blobs.put(scope, bytes);
      const artifact = ArtifactSchema.parse({
        id: newId(),
        hash,
        mime,
        name,
        size,
        createdAt: clock(),
      });
      return artifacts.create(scope, artifact);
    },

    get: (id) => artifacts.getById(scope, id),

    async content(id) {
      const artifact = await artifacts.getById(scope, id);
      if (artifact === null) return null;
      const bytes = await blobs.get(scope, artifact.hash);
      if (bytes === null) return null;
      return { artifact, bytes };
    },

    markReferenced: (id, at) => artifacts.touch(scope, id, at ?? clock()),

    async markAllReferenced(ids, at) {
      const when = at ?? clock();
      for (const id of ids) await artifacts.touch(scope, id, when);
    },

    async sweepUnreferenced(now) {
      const before = new Date(Date.parse(now ?? clock()) - RETENTION_MS).toISOString();
      const candidates = await artifacts.unreferencedBefore(scope, before);

      const deleted: Artifact[] = [];
      for (const artifact of candidates) {
        if (!(await artifacts.delete(scope, artifact.id))) continue;
        await blobs.delete(scope, artifact.hash);
        deleted.push(artifact);
      }
      return deleted;
    },
  };
}
