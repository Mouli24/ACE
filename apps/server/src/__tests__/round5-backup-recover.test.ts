import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BACKUP_CONTENT_TYPE, BACKUP_UPLOAD_FIELD } from '@ace/contracts';
import { openDatabase } from '@ace/storage-local';
import { unzipSync, zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  addCorpusFile,
  createKb,
  createProject,
  listDocuments,
  mockProvider,
  settledDocuments,
  startRound5Engine,
  until,
  type Round5Engine,
} from './round5-harness.js';

/**
 * Final-review M4: a backup restored into a running engine brings documents a process left
 * mid-pipeline back to `pending` and queues them, as a start does (F7) — no restart needed.
 */

let a: Round5Engine;
let b: Round5Engine;
const work = mkdtempSync(join(tmpdir(), 'ace-r5-recover-'));

beforeAll(async () => {
  a = await startRound5Engine();
  b = await startRound5Engine();
}, 60_000);

afterAll(async () => {
  await a?.stop();
  await b?.stop();
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {
    // Windows can still hold a handle for a moment; the OS reclaims temp itself.
  }
});

/** The zip with its database edited: what a backup taken mid-ingestion would hold. */
function withDocumentsInterrupted(zip: Uint8Array): Uint8Array {
  const entries = unzipSync(zip);
  const path = join(work, 'ace.sqlite');
  writeFileSync(path, entries['ace.sqlite']!);
  const { sqlite } = openDatabase({ path, loadVectorExtension: false });
  try {
    sqlite.pragma('journal_mode = DELETE');
    sqlite.prepare(`UPDATE kb_documents SET status = 'parsing'`).run();
  } finally {
    sqlite.close();
  }
  return zipSync({ ...entries, 'ace.sqlite': new Uint8Array(readFileSync(path)) });
}

describe('FR-SYS-012 a restore re-queues documents left mid-pipeline (final-review M4)', () => {
  it('a document restored as parsing is ingested to ready without a restart', async () => {
    const provider = await mockProvider(a);
    const project = await createProject(a, 'Backed up');
    const kb = await createKb(a, project, provider, { name: 'Handbook' });
    await addCorpusFile(a, kb.id, 'handbook.md');
    const [ready] = await settledDocuments(a, kb.id, 1);
    expect(ready?.status).toBe('ready');
    const exported = await a.api('/backup/export', { method: 'POST' });
    expect(exported.status).toBe(200);
    const zip = withDocumentsInterrupted(new Uint8Array(await exported.arrayBuffer()));

    const form = new FormData();
    form.append(BACKUP_UPLOAD_FIELD, new File([zip], 'backup.zip', { type: BACKUP_CONTENT_TYPE }));
    const imported = await b.api('/backup/import', { method: 'POST', body: form });
    expect(imported.status, await imported.clone().text()).toBe(200);

    const restored = await until(
      'the restored document to be ingested again',
      async () => {
        const [doc] = await listDocuments(b, kb.id);
        return doc?.status === 'ready' ? doc : undefined;
      },
      15_000,
    );
    expect(restored).toMatchObject({ id: ready?.id, chunkCount: ready?.chunkCount });
  }, 60_000);
});
