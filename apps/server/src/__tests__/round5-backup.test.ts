import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AgentConfigSchema,
  ApiErrorSchema,
  BACKUP_CONTENT_TYPE,
  BACKUP_UPLOAD_FIELD,
  BackupImportResponseSchema,
  RunSchema,
  SettingsSchema,
  type Settings,
} from '@ace/contracts';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createProject,
  graphBuilder,
  importWorkflow,
  mockProvider,
  runToEnd,
  startRound5Engine,
  until,
  upload,
  type Round5Engine,
} from './round5-harness.js';

/**
 * TC-SYS-014 (FR-SYS-012, round 5 §2.7, F12): a backup exported from data dir A and imported into a
 * clean data dir B brings back the same projects, workflows, runs, artifacts and settings (but B's
 * own `dataDir`); the zip carries no keychain secret, however deep you look; and an import is refused
 * while a run is active, and for a zip that is not an ACE backup.
 */

// Assembled at runtime: a key-shaped literal in a repository file is what CLAUDE.md §2 forbids.
const SECRET = ['sk', 'ant', 'backup', 'k3y9f2b41d7c6e8a0'].join('-');

let a: Round5Engine;
let b: Round5Engine;
const dirB = mkdtempSync(join(tmpdir(), 'ace-r5-restore-'));
let providerId: string;
let artifactId: string;
let zip: Uint8Array;
let disposition: string;
let contentType: string;

beforeAll(async () => {
  a = await startRound5Engine();
  // A provider whose key lives in the keychain — the one thing a backup must never carry (BR-07).
  providerId = await mockProvider(a, { apiKey: SECRET });
  const projectId = await createProject(a, 'Backed up');
  const builder = graphBuilder('Linear');
  const input = builder.add('input', 'Input', {
    text: 'Write a note about backups.',
    artifactIds: [],
    outputTypes: ['text'],
  });
  const writer = builder.add(
    'agent',
    'Writer',
    AgentConfigSchema.parse({
      providerId,
      modelId: 'mock-text',
      instructions: 'Write it.',
      inputTypes: ['text'],
      outputTypes: ['text'],
    }),
  );
  const output = builder.add('output', 'Output', {});
  builder.connect(input, writer);
  builder.connect(writer, output);
  const graph = await importWorkflow(a, projectId, builder.export());
  expect((await runToEnd(a, graph.workflow.id)).status).toBe('COMPLETE');
  artifactId = (await upload(a, 'notes.txt', strToU8('Backed-up notes.'), 'text/plain')).id;
  await a.ok('/settings', {
    method: 'PATCH',
    body: JSON.stringify({ concurrency: 7, theme: 'light', dailyBudgetUsd: 3 }),
    headers: { 'Content-Type': 'application/json' },
  });

  const exported = await a.api('/backup/export', { method: 'POST' });
  expect(exported.status).toBe(200);
  contentType = exported.headers.get('content-type') ?? '';
  disposition = exported.headers.get('content-disposition') ?? '';
  zip = new Uint8Array(await exported.arrayBuffer());

  b = await startRound5Engine({ dataDir: dirB });
}, 60_000);

afterAll(async () => {
  // The key leaves the keychain with its provider.
  await a?.api(`/providers/${providerId}?confirm=true`, { method: 'DELETE' });
  await a?.stop();
  await b?.stop();
  try {
    rmSync(dirB, { recursive: true, force: true });
  } catch {
    // Windows can still hold the SQLite WAL handle for a moment; the OS reclaims temp itself.
  }
});

const importZip = (engine: Round5Engine, bytes: Uint8Array, name = 'backup.zip') => {
  const form = new FormData();
  form.append(BACKUP_UPLOAD_FIELD, new File([bytes], name, { type: BACKUP_CONTENT_TYPE }));
  return engine.api('/backup/import', { method: 'POST', body: form });
};

/** Everything TC-SYS-014 compares, read through the API. */
async function snapshot(engine: Round5Engine): Promise<unknown> {
  const { items: projects } = (await engine.get('/projects')) as { items: { id: string }[] };
  const out: unknown[] = [];
  for (const project of projects) {
    const { items: workflows } = (await engine.get(`/projects/${project.id}/workflows`)) as {
      items: { id: string }[];
    };
    const graphs: unknown[] = [];
    for (const workflow of workflows) {
      const { items: runs } = (await engine.get(`/workflows/${workflow.id}/runs`)) as {
        items: { id: string }[];
      };
      const runRecords: unknown[] = [];
      for (const run of runs) {
        runRecords.push({
          run: await engine.get(`/runs/${run.id}`),
          nodeRuns: await engine.get(`/runs/${run.id}/node-runs`),
          events: await engine.get(`/runs/${run.id}/events`),
        });
      }
      graphs.push({ graph: await engine.get(`/workflows/${workflow.id}`), runs: runRecords });
    }
    out.push({ project, workflows: graphs });
  }
  return out;
}

const withoutDataDir = ({ dataDir: _dataDir, ...rest }: Settings) => rest;

describe('TC-SYS-014 export, then import into a clean data dir', () => {
  it('the export is a zip attachment named by its UTC time', () => {
    expect(contentType).toBe(BACKUP_CONTENT_TYPE);
    expect(disposition).toMatch(/^attachment; filename="ace-backup-\d{8}T\d{6}Z\.zip"$/);
    expect(Object.keys(unzipSync(zip))).toEqual(
      expect.arrayContaining(['ace.sqlite', 'settings.json', 'backup.json']),
    );
  });

  it('a deep scan of every entry finds no keychain secret', () => {
    const entries = unzipSync(zip);
    expect(Object.keys(entries).length).toBeGreaterThan(3);
    for (const [name, bytes] of Object.entries(entries)) {
      const text = Buffer.from(bytes).toString('latin1');
      expect(text.includes(SECRET), `${name} contains the key`).toBe(false);
      expect(Buffer.from(bytes).toString('utf16le').includes(SECRET), `${name} (utf-16)`).toBe(
        false,
      );
    }
  });

  it('restores the same projects, workflows, runs, artifacts and settings', async () => {
    const before = await snapshot(a);
    const settingsA = SettingsSchema.parse(await a.get('/settings'));

    const response = await importZip(b, zip);

    expect(response.status, await response.clone().text()).toBe(200);
    const { restored } = BackupImportResponseSchema.parse(await response.json());
    expect(restored).toEqual({ projects: 1, runs: 1, artifacts: 1 });
    expect(await snapshot(b)).toEqual(before);

    const settingsB = SettingsSchema.parse(await b.get('/settings'));
    expect(settingsB.dataDir).toBe(dirB);
    expect(withoutDataDir(settingsB)).toEqual(withoutDataDir(settingsA));
    expect(settingsB.concurrency).toBe(7);

    // The artifact row and its bytes both came back.
    expect(await b.get(`/artifacts/${artifactId}`)).toEqual(
      await a.get(`/artifacts/${artifactId}`),
    );
    const content = await b.api(`/artifacts/${artifactId}/content`);
    expect(content.status).toBe(200);
    expect(await content.text()).toBe('Backed-up notes.');
    // F12: the data B had before the import is kept as a pre-import backup.
    expect(readdirSync(join(dirB, 'backups')).some((file) => file.endsWith('.zip'))).toBe(true);
  }, 60_000);

  it('a zip that is not an ACE backup is refused 400, and so is a form with no file', async () => {
    const foreign = await importZip(b, zipSync({ 'hello.txt': strToU8('not a backup') }));
    expect(foreign.status).toBe(400);
    expect(ApiErrorSchema.parse(await foreign.json()).error.code).toBe('validation_failed');

    const empty = await b.api('/backup/import', { method: 'POST', body: new FormData() });
    expect(empty.status).toBe(400);
  });

  it('an import while a run is active is refused 409 invalid_run_state', async () => {
    const projectId = await createProject(b, 'Slow');
    const builder = graphBuilder('Slow');
    const input = builder.add('input', 'Input', {
      text: 'Take your time.',
      artifactIds: [],
      outputTypes: ['text'],
    });
    const slow = builder.add(
      'agent',
      'Slow',
      AgentConfigSchema.parse({
        providerId,
        modelId: 'mock-slow',
        instructions: 'Answer slowly.',
        inputTypes: ['text'],
        outputTypes: ['text'],
      }),
    );
    const output = builder.add('output', 'Output', {});
    builder.connect(input, slow);
    builder.connect(slow, output);
    const graph = await importWorkflow(b, projectId, builder.export());
    const run = RunSchema.parse(await b.post(`/workflows/${graph.workflow.id}/runs`));
    expect(run.status).toBe('RUNNING');

    const refused = await importZip(b, zip);

    expect(refused.status).toBe(409);
    const error = ApiErrorSchema.parse(await refused.json()).error;
    expect(error.code).toBe('invalid_run_state');
    expect(error.details).toEqual({ runIds: [run.id] });

    await b.post(`/runs/${run.id}/stop`);
    await until(`run ${run.id} to stop`, async () => {
      const current = RunSchema.parse(await b.get(`/runs/${run.id}`));
      return current.status === 'RUNNING' ? undefined : current;
    });
  }, 60_000);
});
