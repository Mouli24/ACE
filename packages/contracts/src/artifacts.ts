import { z } from 'zod';

import { IdSchema, TimestampSchema } from './graph.js';

/**
 * Artifacts — every uploaded or produced file (round 4 §2.1, FR-MM-001..004, FR-MM-009,
 * Arch §15.1 "Objects", Arch §15.4).
 *
 * The one rule that shapes this module: bytes never travel through the API's JSON. An artifact is
 * a row — hash, mime, name, size — and the bytes live in the blob store behind
 * `GET /artifacts/:id/content`. Nodes exchange `Part` references to that row and never the file
 * itself (FR-MM-004, BR-02), so every object here is strict: a `bytes` or `base64` key is a parse
 * error rather than a silently dropped extra field.
 */

/* -------------------------------------------------------------------------- */
/* Artifact (§2.1)                                                             */
/* -------------------------------------------------------------------------- */

/** A sha256 digest in lowercase hex — the content address that makes uploads idempotent. */
export const SHA256_HEX_REGEX = /^[0-9a-f]{64}$/;
export const ContentHashSchema = z
  .string()
  .regex(SHA256_HEX_REGEX, 'must be a sha256 digest in lowercase hex');

export const ARTIFACT_NAME_MAX = 255;
export const ArtifactNameSchema = z.string().min(1).max(ARTIFACT_NAME_MAX);

export const ArtifactSchema = z.strictObject({
  id: IdSchema,
  /** Identical bytes are stored once, so two uploads of one file share a hash and an id (FR-MM-002). */
  hash: ContentHashSchema,
  mime: z.string().min(1),
  name: ArtifactNameSchema,
  size: z.number().int().min(0),
  createdAt: TimestampSchema,
  /**
   * When a run, a node run or a node config last pointed at this artifact. Arch §15.4 keeps an
   * artifact until it is unreferenced + 7 days, and this is the field that date is counted from.
   */
  lastReferencedAt: TimestampSchema.optional(),
});
export type Artifact = z.infer<typeof ArtifactSchema>;

/* -------------------------------------------------------------------------- */
/* POST /artifacts (§2.1, FR-MM-001, FR-MM-002)                                */
/* -------------------------------------------------------------------------- */

/** The multipart field the bytes arrive in; `POST /artifacts` answers 201 with the `Artifact`. */
export const ARTIFACT_UPLOAD_FIELD = 'file';

/** `POST /artifacts` → 201 `Artifact`; the same bytes twice answer the same id (FR-MM-002). */
export const UploadArtifactResponseSchema = ArtifactSchema;
export type UploadArtifactResponse = z.infer<typeof UploadArtifactResponseSchema>;

/** `GET /artifacts/:id` → `Artifact`. */
export const ArtifactResponseSchema = ArtifactSchema;
export type ArtifactResponse = z.infer<typeof ArtifactResponseSchema>;

/**
 * The response headers `GET /artifacts/:id/content` sets (§2.1, FR-MM-009): the stored `mime`, the
 * original filename as an attachment, the hash as a strong `ETag` so a client can tell it already
 * has the bytes, and byte ranges so audio and video can be seeked.
 */
export const ARTIFACT_CONTENT_HEADERS = Object.freeze({
  contentType: 'Content-Type',
  contentDisposition: 'Content-Disposition',
  etag: 'ETag',
  acceptRanges: 'Accept-Ranges',
} as const);

/** `Accept-Ranges: bytes` — media seeking (§2.1). */
export const ARTIFACT_ACCEPT_RANGES = 'bytes';

/** `ETag: "<hash>"` — quoted, as HTTP requires of a strong validator. */
export const artifactETag = (hash: string): string => `"${hash}"`;

/* -------------------------------------------------------------------------- */
/* The upload limit (FR-MM-001, TC-MM-001)                                     */
/* -------------------------------------------------------------------------- */

export const BYTES_PER_MB = 1024 * 1024;

/** `Settings.maxUploadMb` (§2.1). Over it, `POST /artifacts` is 413 `upload_too_large`. */
export const DEFAULT_MAX_UPLOAD_MB = 100;

/** The limit in bytes, for the engine that enforces it and the mocks that imitate it (D52). */
export const maxUploadBytes = (maxUploadMb: number): number => maxUploadMb * BYTES_PER_MB;

/* -------------------------------------------------------------------------- */
/* The allowed types (§2.1, FR-MM-003, TC-MM-002)                              */
/* -------------------------------------------------------------------------- */

/** Whole families §2.1 allows by prefix: every `text/*` subtype. */
export const ALLOWED_UPLOAD_MIME_PREFIXES = ['text/'] as const;

/** The exact media types §2.1 lists, in its order. */
export const ALLOWED_UPLOAD_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'audio/mpeg',
  'audio/wav',
  'audio/ogg',
  'video/mp4',
  'video/webm',
  'application/json',
  'application/pdf',
  'application/zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
] as const;

/**
 * Other names an allowed type travels by, each mapped to the §2.1 type it means (D-075).
 *
 * A browser takes a file's type from the operating system, not from the file: Chromium on Windows
 * reads the registry, which types `.zip` as `application/x-zip-compressed`, and some systems still
 * send the older `application/x-zip`. Both are the same bytes §2.1 allows as `application/zip`, so
 * refusing them made FR-MM-003's ZIP unuploadable from a Windows browser. An alias only ever points
 * at a type already in `ALLOWED_UPLOAD_MIME_TYPES`, so it widens nothing §2.1 did not already allow
 * (NFR-SEC-05) — and `.zip` stays off the by-name list, which §2.1 limits to nine extensions.
 */
export const ALLOWED_UPLOAD_MIME_ALIASES: Readonly<
  Record<string, (typeof ALLOWED_UPLOAD_MIME_TYPES)[number]>
> = Object.freeze({
  'application/x-zip-compressed': 'application/zip',
  'application/x-zip': 'application/zip',
});

/**
 * Code and text extensions §2.1 allows **by name**, whatever the browser guessed the type to be —
 * a `.ts` file commonly arrives as `video/mp2t` or `application/octet-stream`, and refusing it
 * would make FR-MM-003's "code" data type unuploadable.
 */
export const ALLOWED_UPLOAD_EXTENSIONS = [
  '.ts',
  '.js',
  '.py',
  '.md',
  '.html',
  '.css',
  '.json',
  '.csv',
  '.txt',
] as const;

/** The extension of a filename, lowercased and with its dot, or `''` when it has none. */
export function uploadExtensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot).toLowerCase();
}

/**
 * May these bytes be stored? Pure, so the engine's 415 `unsupported_type` and the web app's
 * client-side refusal cannot disagree about one file (D52's reasoning).
 *
 * A file is allowed when its media type is in §2.1's list — exactly, under one of its aliases, or
 * by an allowed prefix, ignoring any `; charset=` parameter and the case — or when its **name**
 * ends in an allowed extension.
 */
export function isAllowedUpload(file: { mime: string; name: string }): boolean {
  const given = file.mime.split(';')[0]?.trim().toLowerCase() ?? '';
  // An own-property lookup, so a type named like an Object.prototype member is not an alias.
  const mime = Object.hasOwn(ALLOWED_UPLOAD_MIME_ALIASES, given)
    ? ALLOWED_UPLOAD_MIME_ALIASES[given]!
    : given;

  if ((ALLOWED_UPLOAD_MIME_TYPES as readonly string[]).includes(mime)) return true;
  if (ALLOWED_UPLOAD_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix))) return true;

  return (ALLOWED_UPLOAD_EXTENSIONS as readonly string[]).includes(uploadExtensionOf(file.name));
}
