import { describe, expect, it } from 'vitest';

import {
  ALLOWED_UPLOAD_EXTENSIONS,
  ALLOWED_UPLOAD_MIME_ALIASES,
  ALLOWED_UPLOAD_MIME_PREFIXES,
  ALLOWED_UPLOAD_MIME_TYPES,
  ARTIFACT_ACCEPT_RANGES,
  ARTIFACT_NAME_MAX,
  ARTIFACT_UPLOAD_FIELD,
  ArtifactSchema,
  BYTES_PER_MB,
  DEFAULT_MAX_UPLOAD_MB,
  artifactETag,
  isAllowedUpload,
  maxUploadBytes,
  uploadExtensionOf,
} from '../artifacts.js';
import { ChatMessageSchema, ChatRequestSchema, MessageSchema, PostMessageRequestSchema } from '../chat.js';
import { EnvelopeSchema, PartSchema } from '../envelope.js';
import {
  ERROR_CODES,
  ERROR_CODE_HTTP_STATUS,
  UploadTooLargeDetailsSchema,
} from '../errors.js';
import { SettingsSchema } from '../settings.js';
import { ARTIFACT_ID, CHAT_MESSAGE_ID, MESSAGE_ID, NODE_A, NODE_B, NOW, RUN_ID, THREAD_ID, WORKFLOW_ID } from './fixtures.js';

const HASH = 'a'.repeat(64);

const artifact = {
  id: ARTIFACT_ID,
  hash: HASH,
  mime: 'image/png',
  name: 'diagram.png',
  size: 12_345,
  createdAt: NOW,
};

describe('FR-MM-001 FR-MM-002 Artifact (round 4 §2.1)', () => {
  it('is exactly the shape §2.1 writes', () => {
    expect(ArtifactSchema.parse(artifact)).toEqual(artifact);
    expect(ArtifactSchema.parse({ ...artifact, lastReferencedAt: NOW }).lastReferencedAt).toBe(NOW);
  });

  it.each(['id', 'hash', 'mime', 'name', 'size', 'createdAt'])('requires %s', (field) => {
    const partial: Record<string, unknown> = { ...artifact };
    delete partial[field];

    expect(ArtifactSchema.safeParse(partial).success).toBe(false);
  });

  it('takes a sha256 digest in lowercase hex, so identical bytes address one row (FR-MM-002)', () => {
    expect(ArtifactSchema.safeParse({ ...artifact, hash: HASH.toUpperCase() }).success).toBe(false);
    expect(ArtifactSchema.safeParse({ ...artifact, hash: 'a'.repeat(63) }).success).toBe(false);
    expect(ArtifactSchema.safeParse({ ...artifact, hash: 'not a hash' }).success).toBe(false);
  });

  it('names the file in 1..255 characters', () => {
    expect(ARTIFACT_NAME_MAX).toBe(255);
    expect(ArtifactSchema.safeParse({ ...artifact, name: 'x'.repeat(255) }).success).toBe(true);
    expect(ArtifactSchema.safeParse({ ...artifact, name: 'x'.repeat(256) }).success).toBe(false);
    expect(ArtifactSchema.safeParse({ ...artifact, name: '' }).success).toBe(false);
  });

  it('allows a zero-byte file but not a negative size', () => {
    expect(ArtifactSchema.safeParse({ ...artifact, size: 0 }).success).toBe(true);
    expect(ArtifactSchema.safeParse({ ...artifact, size: -1 }).success).toBe(false);
  });

  it.each(['bytes', 'base64', 'data', 'content', 'buffer', 'blob', 'dataUrl', 'path'])(
    'refuses a `%s` key — the row is metadata, the bytes are behind /content (FR-MM-004)',
    (key) => {
      expect(ArtifactSchema.safeParse({ ...artifact, [key]: 'JVBERi0xLjQK' }).success).toBe(false);
    },
  );
});

/* -------------------------------------------------------------------------- */
/* The rule this whole file exists for                                         */
/* -------------------------------------------------------------------------- */

describe('FR-MM-004 BR-02 a file is a reference, never bytes', () => {
  const file = {
    type: 'file' as const,
    artifactId: ARTIFACT_ID,
    mime: 'application/pdf',
    name: 'brief.pdf',
    size: 12_345,
  };

  const BYTE_KEYS = [
    'bytes',
    'base64',
    'data',
    'dataUrl',
    'buffer',
    'blob',
    'content',
    'body',
    'inline',
  ];

  it.each(['image', 'audio', 'video', 'file'])(
    'requires the artifactId on a %s part (round 4 §3)',
    (type) => {
      const { artifactId: _artifactId, ...withoutId } = file;

      expect(PartSchema.safeParse({ ...withoutId, type }).success).toBe(false);
      expect(PartSchema.parse({ ...file, type })).toEqual({ ...file, type });
    },
  );

  it.each(BYTE_KEYS)('refuses a file part carrying `%s`', (key) => {
    expect(PartSchema.safeParse({ ...file, [key]: 'JVBERi0xLjQK' }).success).toBe(false);
  });

  it.each(BYTE_KEYS)('refuses `%s` on an image part too', (key) => {
    expect(
      PartSchema.safeParse({ ...file, type: 'image', mime: 'image/png', [key]: 'iVBORw0K' }).success,
    ).toBe(false);
  });

  it('refuses bytes inside an envelope that a node would read (BR-02, TC-MM-004)', () => {
    const envelope = {
      id: ARTIFACT_ID,
      runId: RUN_ID,
      fromNodeId: NODE_A,
      toNodeId: NODE_B,
      iteration: 1,
      reads: [{ ...file, bytes: 'JVBERi0xLjQK' }],
      context: { budgetTokens: 4000, trust: 'untrusted' },
      contract: { outputTypes: ['text'] },
      createdAt: NOW,
    };

    expect(EnvelopeSchema.safeParse(envelope).success).toBe(false);
    expect(
      EnvelopeSchema.safeParse({ ...envelope, reads: [file] }).success,
      'the same envelope with a plain reference is fine',
    ).toBe(true);
  });

  it('refuses bytes in a timeline message and in a chat turn (FR-CHAT-007)', () => {
    const leaky = [{ ...file, base64: 'JVBERi0xLjQK' }];

    expect(
      MessageSchema.safeParse({
        id: MESSAGE_ID,
        workflowId: WORKFLOW_ID,
        type: 'user',
        content: leaky,
        at: NOW,
      }).success,
    ).toBe(false);
    expect(
      ChatMessageSchema.safeParse({
        id: CHAT_MESSAGE_ID,
        threadId: THREAD_ID,
        role: 'user',
        content: leaky,
        verdicts: [],
        at: NOW,
      }).success,
    ).toBe(false);
    expect(PostMessageRequestSchema.safeParse({ content: leaky, run: false }).success).toBe(false);
    expect(ChatRequestSchema.safeParse({ content: leaky }).success).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* POST /artifacts                                                             */
/* -------------------------------------------------------------------------- */

describe('TC-MM-001 the upload limit (FR-MM-001)', () => {
  it('defaults to 100 MB, on the settings and in bytes', () => {
    expect(DEFAULT_MAX_UPLOAD_MB).toBe(100);
    expect(BYTES_PER_MB).toBe(1_048_576);
    expect(maxUploadBytes(DEFAULT_MAX_UPLOAD_MB)).toBe(104_857_600);
    expect(SettingsSchema.parse({ dataDir: '.' }).maxUploadMb).toBe(100);
  });

  it('answers 413 upload_too_large, naming the limit in bytes', () => {
    expect(ERROR_CODES).toContain('upload_too_large');
    expect(ERROR_CODE_HTTP_STATUS.upload_too_large).toBe(413);
    expect(UploadTooLargeDetailsSchema.parse({ maxBytes: 104_857_600 })).toEqual({
      maxBytes: 104_857_600,
    });
    expect(UploadTooLargeDetailsSchema.safeParse({ maxBytes: 0 }).success).toBe(false);
  });

  it('answers 415 unsupported_type for a type §2.1 does not allow', () => {
    expect(ERROR_CODES).toContain('unsupported_type');
    expect(ERROR_CODE_HTTP_STATUS.unsupported_type).toBe(415);
  });

  it('takes the bytes in the multipart field §2.1 names, and sets the seeking headers', () => {
    expect(ARTIFACT_UPLOAD_FIELD).toBe('file');
    expect(ARTIFACT_ACCEPT_RANGES).toBe('bytes');
    expect(artifactETag(HASH)).toBe(`"${HASH}"`);
  });
});

describe('TC-MM-002 FR-MM-003 the allow-list of §2.1', () => {
  it('lists exactly the media types §2.1 names, in its order', () => {
    expect([...ALLOWED_UPLOAD_MIME_TYPES]).toEqual([
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
    ]);
    expect([...ALLOWED_UPLOAD_MIME_PREFIXES]).toEqual(['text/']);
    expect([...ALLOWED_UPLOAD_EXTENSIONS]).toEqual([
      '.ts',
      '.js',
      '.py',
      '.md',
      '.html',
      '.css',
      '.json',
      '.csv',
      '.txt',
    ]);
  });

  it.each([...ALLOWED_UPLOAD_MIME_TYPES])('allows %s', (mime) => {
    expect(isAllowedUpload({ mime, name: 'upload.bin' })).toBe(true);
  });

  it.each(['text/plain', 'text/markdown', 'text/csv', 'text/x-python'])(
    'allows the whole text family — %s',
    (mime) => {
      expect(isAllowedUpload({ mime, name: 'notes.bin' })).toBe(true);
    },
  );

  it('ignores a charset parameter and the case of the type', () => {
    expect(isAllowedUpload({ mime: 'text/plain; charset=utf-8', name: 'a.bin' })).toBe(true);
    expect(isAllowedUpload({ mime: 'IMAGE/PNG', name: 'a.bin' })).toBe(true);
  });

  it.each([...ALLOWED_UPLOAD_EXTENSIONS])(
    'allows %s by name, whatever the browser guessed the type to be',
    (extension) => {
      expect(isAllowedUpload({ mime: 'application/octet-stream', name: `script${extension}` })).toBe(
        true,
      );
      expect(isAllowedUpload({ mime: 'video/mp2t', name: `SCRIPT${extension.toUpperCase()}` })).toBe(
        true,
      );
    },
  );

  it.each([
    ['application/x-msdownload', 'setup.exe'],
    ['application/x-sh', 'run.sh'],
    ['image/svg+xml', 'logo.svg'],
    ['application/octet-stream', 'blob'],
    ['', ''],
  ])('refuses %s named %s', (mime, name) => {
    expect(isAllowedUpload({ mime, name })).toBe(false);
  });

  it('reads an extension only when there is one', () => {
    expect(uploadExtensionOf('report.final.PDF')).toBe('.pdf');
    expect(uploadExtensionOf('Makefile')).toBe('');
    expect(uploadExtensionOf('.gitignore')).toBe('');
    expect(uploadExtensionOf('trailing.')).toBe('');
  });
});

/*
 * D-075: Chromium on Windows types a `.zip` read from disk as `application/x-zip-compressed` (the
 * Windows registry's type), so FR-MM-003's ZIP could never be uploaded from a browser there. The
 * fix is an alias of an allowed type, not a new type and not `.zip` by name (§2.1 names nine).
 */
describe('FR-MM-003 NFR-SEC-05 TC-MM-003 a ZIP is allowed under the other names it travels by', () => {
  it.each([
    'application/x-zip-compressed',
    'application/x-zip',
    'APPLICATION/X-ZIP-COMPRESSED',
    'application/x-zip-compressed; charset=binary',
  ])('allows a ZIP typed %s, whatever it is named', (mime) => {
    expect(isAllowedUpload({ mime, name: 'sample.zip' })).toBe(true);
    expect(isAllowedUpload({ mime, name: 'bundle.bin' })).toBe(true);
  });

  it('names only aliases of a type §2.1 already allows, and leaves §2.1’s own list as it was', () => {
    expect({ ...ALLOWED_UPLOAD_MIME_ALIASES }).toEqual({
      'application/x-zip-compressed': 'application/zip',
      'application/x-zip': 'application/zip',
    });
    for (const canonical of Object.values(ALLOWED_UPLOAD_MIME_ALIASES)) {
      expect(ALLOWED_UPLOAD_MIME_TYPES as readonly string[]).toContain(canonical);
    }
    expect(ALLOWED_UPLOAD_MIME_TYPES as readonly string[]).not.toContain(
      'application/x-zip-compressed',
    );
    expect(ALLOWED_UPLOAD_EXTENSIONS as readonly string[]).not.toContain('.zip');
  });

  it('still refuses a .zip whose type names no ZIP — the extension is not on the by-name list', () => {
    expect(isAllowedUpload({ mime: 'application/octet-stream', name: 'sample.zip' })).toBe(false);
    expect(isAllowedUpload({ mime: 'application/x-zip-compressed-evil', name: 'x.bin' })).toBe(
      false,
    );
    expect(isAllowedUpload({ mime: 'application/x-7z-compressed', name: 'x.7z' })).toBe(false);
  });
});
