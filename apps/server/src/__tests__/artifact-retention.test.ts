import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ArtifactSchema,
  ProjectSchema,
  ProviderSchema,
  type Artifact,
  type WorkflowExport,
} from '@ace/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startEngine, type RunningEngine } from '../server.js';

/**
 * Arch §15.4 (D-070): an artifact lives "until unreferenced + 7 days". Round 4 §4 item 1 asks for the
 * sweep with an injectable clock, so these tests start the real engine with a clock they own, move it,
 * and watch what `GET /artifacts/:id` answers. Three ways a sweep runs: once at start, on a timer,
 * and on demand through `RunningEngine.sweepArtifacts()` — never through a REST endpoint (§2.4 has
 * none). Referenced artifacts (here, an Input node's `artifactIds`) survive whatever the clock says.
 */

const T0 = Date.parse('2026-09-01T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const fixturesDir = new URL('../../../../tests/acceptance/fixtures/round-4/', import.meta.url);

/** A clock the test moves by hand. */
function manualClock(start = T0): { now: () => string; advanceDays: (days: number) => void } {
  let at = start;
  return {
    now: () => new Date(at).toISOString(),
    advanceDays: (days) => {
      at += days * DAY;
    },
  };
}

const started: RunningEngine[] = [];
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ace-retention-'));
});

afterEach(async () => {
  for (const engine of started.splice(0)) await engine.stop();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows can still hold the SQLite WAL handle for a moment; the OS reclaims temp itself.
  }
});

async function boot(
  options: Omit<Parameters<typeof startEngine>[0], 'dataDir'>,
): Promise<RunningEngine> {
  const engine = await startEngine({ dataDir: dir, port: 0, env: {}, ...options });
  started.push(engine);
  return engine;
}

const headers = (engine: RunningEngine) => ({ Authorization: `Bearer ${engine.token}` });

async function upload(engine: RunningEngine, text: string, name: string): Promise<Artifact> {
  const form = new FormData();
  form.append('file', new File([new TextEncoder().encode(text)], name, { type: 'text/plain' }));
  const response = await fetch(`${engine.url}/api/v1/artifacts`, {
    method: 'POST',
    headers: headers(engine),
    body: form,
  });
  expect(response.status).toBe(201);
  return ArtifactSchema.parse(await response.json());
}

const rowStatus = async (engine: RunningEngine, id: string): Promise<number> =>
  (await fetch(`${engine.url}/api/v1/artifacts/${id}`, { headers: headers(engine) })).status;

const contentStatus = async (engine: RunningEngine, id: string): Promise<number> =>
  (await fetch(`${engine.url}/api/v1/artifacts/${id}/content`, { headers: headers(engine) }))
    .status;

async function post(engine: RunningEngine, path: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${engine.url}/api/v1${path}`, {
    method: 'POST',
    headers: { ...headers(engine), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(response.status, `${path}: ${await response.clone().text()}`).toBeLessThan(300);
  return response.json();
}

/** `vision.json` imported with its Input node attaching `artifactId` — a live reference. */
async function referenceFromInputNode(engine: RunningEngine, artifactId: string): Promise<void> {
  const provider = ProviderSchema.parse(
    await post(engine, '/providers', { type: 'mock', name: 'Mock' }),
  );
  const project = ProjectSchema.parse(await post(engine, '/projects', { name: 'Retention' }));
  const text = readFileSync(new URL('vision.json', fixturesDir), 'utf8')
    .replaceAll('01M4R4PV0000000000000000PV', provider.id)
    .replaceAll('01M4R4AR0000000000000000AR', artifactId);
  await post(
    engine,
    `/projects/${project.id}/workflows/import`,
    JSON.parse(text) as WorkflowExport,
  );
}

describe('Arch §15.4 artifact retention: unreferenced + 7 days, on the injected clock (D-070)', () => {
  it('sweepArtifacts() keeps an orphan for 7 days, then deletes its row and bytes; a referenced one stays', async () => {
    const clock = manualClock();
    const engine = await boot({ clock: clock.now });

    const orphan = await upload(engine, 'nobody points at me', 'orphan.txt');
    const kept = await upload(engine, 'an Input node points at me', 'kept.txt');
    await referenceFromInputNode(engine, kept.id);
    expect(orphan.createdAt).toBe(clock.now());

    clock.advanceDays(6);
    expect(await engine.sweepArtifacts()).toEqual([]);
    expect(await rowStatus(engine, orphan.id)).toBe(200);

    clock.advanceDays(2);
    const swept = await engine.sweepArtifacts();

    expect(swept.map((artifact) => artifact.id)).toEqual([orphan.id]);
    expect(await rowStatus(engine, orphan.id)).toBe(404);
    expect(await contentStatus(engine, orphan.id)).toBe(404);
    expect(await rowStatus(engine, kept.id)).toBe(200);
    expect(await contentStatus(engine, kept.id)).toBe(200);
  });

  it('sweeps once at start, so an engine that was off for a week does not keep what expired meanwhile', async () => {
    const clock = manualClock();
    const first = await boot({ clock: clock.now });
    const orphan = await upload(first, 'left behind', 'orphan.txt');
    await first.stop();
    started.splice(0);

    clock.advanceDays(8);
    const second = await boot({ clock: clock.now });

    expect(await rowStatus(second, orphan.id)).toBe(404);
  });

  it('sweeps again on its own timer, with no call from anyone', async () => {
    const clock = manualClock();
    const engine = await boot({ clock: clock.now, artifactSweepIntervalMs: 20 });
    const orphan = await upload(engine, 'swept by the timer', 'orphan.txt');

    clock.advanceDays(8);

    const deadline = Date.now() + 5_000;
    while ((await rowStatus(engine, orphan.id)) !== 404) {
      if (Date.now() > deadline) throw new Error('the timer never swept the orphan');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  });

  it('stops the timer with the engine: stop() resolves and the data directory can be released', async () => {
    const clock = manualClock();
    const engine = await boot({ clock: clock.now, artifactSweepIntervalMs: 5 });
    await upload(engine, 'still here', 'orphan.txt');

    await new Promise((resolve) => setTimeout(resolve, 30));
    await engine.stop();

    // A sweep that ran after the database closed would throw on the timer; give it the chance.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await engine.sweepArtifacts()).toEqual([]);
  });

  it('defaults to the wall clock: a fresh upload is not swept', async () => {
    const engine = await boot({});
    const fresh = await upload(engine, 'just arrived', 'fresh.txt');

    expect(await engine.sweepArtifacts()).toEqual([]);
    expect(await rowStatus(engine, fresh.id)).toBe(200);
  });
});
