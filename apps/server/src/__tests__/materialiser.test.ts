import { createHash } from 'node:crypto';

import type { Artifact, Id, Part } from '@ace/contracts';
import type { ArtifactService, ProducedPart } from '@ace/engine';
import { MOCK_MEDIA_TYPES, mockMediaFixture } from '@ace/providers';
import { describe, expect, it } from 'vitest';

import { createArtifactMaterialiser } from '../server.js';

/**
 * The server's `ArtifactMaterialiser` (FR-MM-003/004, D-082): what it stores for a model's produced
 * parts, over an in-memory artifact store that hashes and dedupes the way the real one does. The
 * whole path over HTTP — the real store, the content route — is `server.test.ts`'s "D-082" test.
 */

const PLACEHOLDER = '01JBXQ8Z9KQ4R7N2VWXYZ0PLAC';
const EXISTING = '01JBXQ8Z9KQ4R7N2VWXYZ0EXST';
const NOW = '2026-09-30T10:00:00.000Z';

type Store = Pick<ArtifactService, 'get' | 'upload' | 'markReferenced'>;

function memoryStore(seed: Artifact[] = []) {
  const rows = new Map<Id, Artifact>(seed.map((row) => [row.id, row]));
  const blobs = new Map<string, Uint8Array>();
  const referenced: Id[] = [];
  let next = 0;

  const store: Store = {
    get: async (id) => rows.get(id) ?? null,
    async upload(source, meta) {
      if (!(source instanceof Uint8Array)) throw new Error('the materialiser uploads bytes');
      const hash = createHash('sha256').update(source).digest('hex');
      const existing = [...rows.values()].find((row) => row.hash === hash);
      if (existing !== undefined) return existing;
      blobs.set(hash, source.slice());
      const row: Artifact = {
        id: `01JBXQ8Z9KQ4R7N2VWXYZ0ST${String(next++).padStart(2, '0')}`,
        hash,
        mime: meta.mime,
        name: meta.name,
        size: source.byteLength,
        createdAt: NOW,
      };
      rows.set(row.id, row);
      return row;
    },
    async markReferenced(id) {
      referenced.push(id);
      return rows.get(id) ?? null;
    },
  };
  return { store, rows, blobs, referenced };
}

/** What `mock-media` hands the executor for one media type: a placeholder reference plus the bytes. */
function produced(type: (typeof MOCK_MEDIA_TYPES)[number]): ProducedPart {
  const { mime, name, bytes } = mockMediaFixture(type);
  return { part: { type, artifactId: PLACEHOLDER, mime, name, size: bytes.byteLength }, bytes };
}

describe('FR-MM-003 D-082 the materialiser stores the bytes a provider produced', () => {
  it('uploads each media part’s own bytes and references the stored artifact — hash sha256, size the stored size', async () => {
    const { store, rows, blobs, referenced } = memoryStore();
    const materialiser = createArtifactMaterialiser(store);

    const out = await materialiser.store(MOCK_MEDIA_TYPES.map(produced));

    expect(out).toHaveLength(MOCK_MEDIA_TYPES.length);
    for (const [index, type] of MOCK_MEDIA_TYPES.entries()) {
      const part = out[index] as Extract<Part, { artifactId: string }>;
      const fixture = mockMediaFixture(type);
      const row = rows.get(part.artifactId);
      expect(part.type).toBe(type);
      expect(part.artifactId, type).not.toBe(PLACEHOLDER);
      expect(row, type).toBeDefined();
      // The stored bytes are the fixture — not `size` zero bytes.
      expect(blobs.get(row!.hash), type).toEqual(fixture.bytes);
      expect(row!.hash, type).toBe(createHash('sha256').update(fixture.bytes).digest('hex'));
      expect(part.size, type).toBe(fixture.bytes.byteLength);
      expect(row!.size, type).toBe(part.size);
      expect(row!.mime, type).toBe(fixture.mime);
    }
    // Each stored artifact is marked referenced, so retention counts from this output (Arch §15.4).
    expect(referenced.sort()).toEqual([...rows.keys()].sort());
    // FR-MM-004: what comes back is references only.
    expect(JSON.stringify(out)).not.toMatch(/bytes|base64/);
  });

  it('FR-MM-002 identical bytes produced twice address one artifact', async () => {
    const { store, rows } = memoryStore();
    const materialiser = createArtifactMaterialiser(store);

    const [first] = await materialiser.store([produced('image')]);
    const [second] = await materialiser.store([produced('image')]);

    expect(second).toEqual(first);
    expect(rows.size).toBe(1);
  });

  it('passes text, json and code through untouched', async () => {
    const { store, rows } = memoryStore();
    const parts: Part[] = [
      { type: 'text', text: 'a caption' },
      { type: 'json', value: { ok: true } },
      { type: 'code', language: 'javascript', text: 'export const answer = 42;' },
    ];

    const out = await createArtifactMaterialiser(store).store(parts.map((part) => ({ part })));

    expect(out).toEqual(parts);
    expect(rows.size).toBe(0);
  });

  it('keeps a media part that already references a stored artifact, with the stored size', async () => {
    const existing: Artifact = {
      id: EXISTING,
      hash: 'a'.repeat(64),
      mime: 'image/png',
      name: 'upload.png',
      size: 88,
      createdAt: NOW,
    };
    const { store, referenced } = memoryStore([existing]);
    const part: Part = {
      type: 'image',
      artifactId: EXISTING,
      mime: 'image/png',
      name: 'upload.png',
      size: 1,
    };

    const out = await createArtifactMaterialiser(store).store([{ part }]);

    expect(out).toEqual([{ ...part, size: 88 }]);
    expect(referenced).toEqual([EXISTING]);
  });

  it('refuses a media part with no bytes and no stored artifact behind it — no zero-filled stand-in', async () => {
    const { store, rows } = memoryStore();
    const part: Part = {
      type: 'video',
      artifactId: PLACEHOLDER,
      mime: 'video/mp4',
      name: 'clip.mp4',
      size: 256,
    };

    await expect(createArtifactMaterialiser(store).store([{ part }])).rejects.toThrow(
      /not stored.*no bytes/,
    );
    expect(rows.size).toBe(0);
  });
});
