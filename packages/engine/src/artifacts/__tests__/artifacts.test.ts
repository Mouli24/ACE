import { createHash } from 'node:crypto';

import { SettingsSchema, maxUploadBytes, type Settings } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { FakeRepository } from '../../__tests__/fake-repository.js';
import { LOCAL_SCOPE, type BlobRef, type BlobStore, type Scope } from '../../ports/index.js';
import {
  ARTIFACT_RETENTION_DAYS,
  UnsupportedTypeError,
  UploadTooLargeError,
  createArtifactService,
  type ArtifactService,
  type SettingsReader,
  type UploadSource,
} from '../index.js';

/**
 * The artifact store (round 4 §2.1, §4 item 1, FR-MM-001/002/009, Arch §15.4).
 *
 * Tested against `FakeRepository` and the in-memory `BlobStore` below, so it runs with zero env
 * vars; the SQLite/`FsBlobStore` pairing is covered in `packages/storage-local`.
 */

/** A `BlobStore` in a Map — the same content-addressing as `FsBlobStore`, without the disk. */
class MemoryBlobStore implements BlobStore {
  readonly blobs = new Map<string, Uint8Array>();

  #key(scope: Scope, hash: string): string {
    return `${scope.workspaceId}:${hash}`;
  }

  async put(scope: Scope, bytes: Uint8Array): Promise<BlobRef> {
    const hash = createHash('sha256').update(bytes).digest('hex');
    this.blobs.set(this.#key(scope, hash), bytes);
    return { hash, size: bytes.byteLength };
  }

  async get(scope: Scope, hash: string): Promise<Uint8Array | null> {
    return this.blobs.get(this.#key(scope, hash)) ?? null;
  }

  async has(scope: Scope, hash: string): Promise<boolean> {
    return this.blobs.has(this.#key(scope, hash));
  }

  async delete(scope: Scope, hash: string): Promise<boolean> {
    return this.blobs.delete(this.#key(scope, hash));
  }
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const settingsWith = (maxUploadMb: number): SettingsReader => {
  const config: Settings = SettingsSchema.parse({ dataDir: '/tmp/ace', maxUploadMb });
  return { get: async (): Promise<Settings> => config };
};

/** Yields `bytes` in ~64 KB chunks, counting how many chunks were actually pulled. */
function chunked(bytes: Uint8Array): { source: UploadSource; pulled: () => number } {
  let pulled = 0;
  const size = 64 * 1024;
  async function* gen(): AsyncGenerator<Uint8Array> {
    for (let offset = 0; offset < bytes.byteLength; offset += size) {
      pulled += 1;
      yield bytes.subarray(offset, offset + size);
    }
  }
  return { source: gen(), pulled: () => pulled };
}

interface Harness {
  service: ArtifactService;
  repo: FakeRepository;
  blobs: MemoryBlobStore;
  setNow: (at: string) => void;
}

function harness(settings: SettingsReader = settingsWith(100)): Harness {
  const repo = new FakeRepository();
  const blobs = new MemoryBlobStore();
  let now = '2026-09-01T00:00:00.000Z';
  const service = createArtifactService({
    scope: LOCAL_SCOPE,
    artifacts: repo.artifacts,
    blobs,
    settings,
    clock: () => now,
  });
  return { service, repo, blobs, setNow: (at) => (now = at) };
}

const text = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('TC-MM-001 upload size limit (FR-MM-001)', () => {
  it('stores an upload within the limit and returns its row', async () => {
    const { service, blobs } = harness();
    const bytes = text('hello world');

    const artifact = await service.upload(bytes, { mime: 'text/plain', name: 'hello.txt' });

    expect(artifact.size).toBe(bytes.byteLength);
    expect(artifact.hash).toBe(sha256(bytes));
    expect(artifact.mime).toBe('text/plain');
    expect(artifact.name).toBe('hello.txt');
    expect(artifact.createdAt).toBe('2026-09-01T00:00:00.000Z');
    expect(artifact.lastReferencedAt).toBeUndefined();
    expect(await blobs.has(LOCAL_SCOPE, artifact.hash)).toBe(true);
  });

  it('refuses a buffer over the limit with UploadTooLargeError carrying maxBytes', async () => {
    const { service } = harness(settingsWith(1));
    const tooBig = new Uint8Array(maxUploadBytes(1) + 1);

    const error = await service.upload(tooBig, { mime: 'text/plain', name: 'big.txt' }).catch((e) => e);

    expect(error).toBeInstanceOf(UploadTooLargeError);
    expect(error.maxBytes).toBe(maxUploadBytes(1));
    expect(error.code).toBe('upload_too_large');
    expect(error.details).toEqual({ maxBytes: maxUploadBytes(1) });
  });

  it('aborts an over-limit stream before it is fully read', async () => {
    const { service, blobs } = harness(settingsWith(1));
    const { source, pulled } = chunked(new Uint8Array(maxUploadBytes(1) + 5 * 64 * 1024));

    await expect(service.upload(source, { mime: 'text/plain', name: 'big.txt' })).rejects.toBeInstanceOf(
      UploadTooLargeError,
    );

    // The limit is 16 × 64 KB; the stream is stopped a chunk after crossing it, not fully drained.
    expect(pulled()).toBeLessThan(21);
    expect(blobs.blobs.size).toBe(0);
  });

  it('stores an upload arriving as a chunked stream', async () => {
    const { service } = harness();
    const bytes = text('streamed content across chunks');
    const { source } = chunked(bytes);

    const artifact = await service.upload(source, { mime: 'text/plain', name: 'stream.txt' });

    expect(artifact.hash).toBe(sha256(bytes));
    expect(artifact.size).toBe(bytes.byteLength);
  });
});

describe('TC-MM-002 dedupe by hash (FR-MM-002)', () => {
  it('answers the same id for identical bytes and stores nothing twice', async () => {
    const { service, repo, blobs } = harness();
    const bytes = text('the same picture, uploaded twice');

    const first = await service.upload(bytes, { mime: 'image/png', name: 'a.png' });
    const second = await service.upload(bytes, { mime: 'image/png', name: 'b.png' });

    expect(second.id).toBe(first.id);
    expect(second.name).toBe('a.png'); // the existing row, not the second name
    expect(blobs.blobs.size).toBe(1);
    const rows = await repo.artifacts.list(LOCAL_SCOPE, { limit: 10 });
    expect(rows.items).toHaveLength(1);
  });

  it('gives different bytes different rows', async () => {
    const { service, blobs } = harness();

    const a = await service.upload(text('one'), { mime: 'text/plain', name: 'one.txt' });
    const b = await service.upload(text('two'), { mime: 'text/plain', name: 'two.txt' });

    expect(b.id).not.toBe(a.id);
    expect(blobs.blobs.size).toBe(2);
  });
});

describe('TC-MM-002 type allow-list (FR-MM-003)', () => {
  it('refuses a type off the allow-list with UnsupportedTypeError', async () => {
    const { service } = harness();

    const error = await service
      .upload(text('#!/bin/sh'), { mime: 'application/x-sh', name: 'run.sh' })
      .catch((e) => e);

    expect(error).toBeInstanceOf(UnsupportedTypeError);
    expect(error.code).toBe('unsupported_type');
    expect(error.details).toEqual({ mime: 'application/x-sh', name: 'run.sh' });
  });

  it('accepts a code file allowed by its extension whatever the browser guessed', async () => {
    const { service } = harness();

    const artifact = await service.upload(text('export const x = 1;'), {
      mime: 'video/mp2t', // what a .ts file often arrives as
      name: 'module.ts',
    });

    expect(artifact.mime).toBe('video/mp2t');
    expect(artifact.name).toBe('module.ts');
  });

  it('defaults a blank mime to application/octet-stream for a file allowed by name', async () => {
    const { service } = harness();

    const artifact = await service.upload(text('col1,col2'), { mime: '', name: 'data.csv' });

    expect(artifact.mime).toBe('application/octet-stream');
  });

  it('rejects a name outside 1..255 characters', async () => {
    const { service } = harness();

    await expect(
      service.upload(text('x'), { mime: 'text/plain', name: 'x'.repeat(256) }),
    ).rejects.toThrow();
  });
});

describe('get and content (§2.4, FR-MM-009)', () => {
  it('returns the row from get and null when it is absent', async () => {
    const { service } = harness();
    const stored = await service.upload(text('body'), { mime: 'text/plain', name: 'f.txt' });

    expect(await service.get(stored.id)).toEqual(stored);
    expect(await service.get('missing')).toBeNull();
  });

  it('serves bytes whose hash matches the row (TC-MM-008)', async () => {
    const { service } = harness();
    const bytes = text('download me and check the hash');
    const stored = await service.upload(bytes, { mime: 'text/plain', name: 'dl.txt' });

    const content = await service.content(stored.id);

    expect(content).not.toBeNull();
    expect(content!.bytes).toEqual(bytes);
    expect(sha256(content!.bytes)).toBe(stored.hash);
    expect(content!.artifact.mime).toBe('text/plain');
  });

  it('returns null for content when the row is missing', async () => {
    const { service } = harness();
    expect(await service.content('missing')).toBeNull();
  });

  it('returns null for content when the blob has gone', async () => {
    const { service, blobs } = harness();
    const stored = await service.upload(text('orphan'), { mime: 'text/plain', name: 'o.txt' });
    await blobs.delete(LOCAL_SCOPE, stored.hash);

    expect(await service.content(stored.id)).toBeNull();
  });
});

describe('reference tracking (Arch §15.4)', () => {
  it('markReferenced sets lastReferencedAt and returns null for a missing id', async () => {
    const { service } = harness();
    const stored = await service.upload(text('ref'), { mime: 'text/plain', name: 'r.txt' });

    const touched = await service.markReferenced(stored.id, '2026-09-05T00:00:00.000Z');
    expect(touched?.lastReferencedAt).toBe('2026-09-05T00:00:00.000Z');
    expect(await service.markReferenced('missing')).toBeNull();
  });

  it('markAllReferenced touches every id it is given', async () => {
    const { service } = harness();
    const a = await service.upload(text('a'), { mime: 'text/plain', name: 'a.txt' });
    const b = await service.upload(text('b'), { mime: 'text/plain', name: 'b.txt' });

    await service.markAllReferenced([a.id, b.id], '2026-09-06T00:00:00.000Z');

    expect((await service.get(a.id))?.lastReferencedAt).toBe('2026-09-06T00:00:00.000Z');
    expect((await service.get(b.id))?.lastReferencedAt).toBe('2026-09-06T00:00:00.000Z');
  });
});

describe('sweepUnreferenced (Arch §15.4)', () => {
  it('deletes an artifact unreferenced for more than the retention window, row and blob', async () => {
    const { service, repo, blobs } = harness();
    const stored = await service.upload(text('stale'), { mime: 'text/plain', name: 's.txt' });
    // created 2026-09-01; more than 7 days later there is no reference to it.
    const later = new Date(Date.parse('2026-09-01T00:00:00.000Z') + (ARTIFACT_RETENTION_DAYS + 1) * 86_400_000).toISOString();

    const swept = await service.sweepUnreferenced(later);

    expect(swept.map((a) => a.id)).toEqual([stored.id]);
    expect(await repo.artifacts.getById(LOCAL_SCOPE, stored.id)).toBeNull();
    expect(await blobs.has(LOCAL_SCOPE, stored.hash)).toBe(false);
  });

  it('keeps an artifact still inside the window', async () => {
    const { service, repo } = harness();
    const stored = await service.upload(text('fresh'), { mime: 'text/plain', name: 'f.txt' });
    const soon = new Date(Date.parse('2026-09-01T00:00:00.000Z') + 3 * 86_400_000).toISOString();

    expect(await service.sweepUnreferenced(soon)).toEqual([]);
    expect(await repo.artifacts.getById(LOCAL_SCOPE, stored.id)).not.toBeNull();
  });

  it('keeps an artifact whose reference clock was moved forward', async () => {
    const { service, repo } = harness();
    const stored = await service.upload(text('touched'), { mime: 'text/plain', name: 't.txt' });
    // Referenced 6 days after creation, then swept 8 days after creation → still inside the window.
    await service.markReferenced(stored.id, '2026-09-07T00:00:00.000Z');

    const swept = await service.sweepUnreferenced('2026-09-09T00:00:00.000Z');

    expect(swept).toEqual([]);
    expect(await repo.artifacts.getById(LOCAL_SCOPE, stored.id)).not.toBeNull();
  });

  it('uses the injected clock when no now is passed', async () => {
    const { service, repo, setNow } = harness();
    const stored = await service.upload(text('clocked'), { mime: 'text/plain', name: 'c.txt' });
    setNow('2026-10-01T00:00:00.000Z'); // a month on

    const swept = await service.sweepUnreferenced();

    expect(swept.map((a) => a.id)).toEqual([stored.id]);
    expect(await repo.artifacts.getById(LOCAL_SCOPE, stored.id)).toBeNull();
  });
});
