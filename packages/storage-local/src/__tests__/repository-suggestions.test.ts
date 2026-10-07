import type { ProjectNote, Responsibility, Suggestion } from '@ace/contracts';
import { newId, SecretWriteRejectedError } from '@ace/engine';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeProject, NOW, scope } from './fixtures.js';
import { createTempDb, type TempDb } from './temp-db.js';

/** The ACE parity P2 storage (D280, D281) on a real SQLite file. */

let db: TempDb;

beforeEach(() => {
  db = createTempDb();
});

afterEach(() => {
  db.close();
});

const LATER = '2026-09-21T11:00:00.000Z';
/** Key-shaped, assembled at runtime so no key literal is in the repository (CLAUDE.md §2). */
const KEY = ['sk', '-', 'a1B2'.repeat(8)].join('');

async function seedProject() {
  const project = makeProject();
  await db.repository.projects.create(scope, project);
  return project;
}

function responsibility(
  projectId: string,
  overrides: Partial<Responsibility> = {},
): Responsibility {
  return {
    id: newId(),
    projectId,
    kind: 'software_health',
    title: 'Keep main green',
    why: 'Releases break otherwise.',
    goodWork: 'Every check passes.',
    watch: false,
    watchIntervalMinutes: 60,
    paused: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function suggestion(owner: Responsibility, overrides: Partial<Suggestion> = {}): Suggestion {
  return {
    id: newId(),
    projectId: owner.projectId,
    responsibilityId: owner.id,
    title: 'Fix the failing tests check',
    reason: 'It failed on #4.',
    evidence: [{ kind: 'failed_check', label: 'tests failed', detail: '1 failed' }],
    proposedAction: 'Make it pass.',
    completionCriteria: 'pnpm test passes.',
    status: 'new',
    fingerprint: 'check:t4:tests',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('D280 responsibilities', () => {
  it('round-trips, lists watched ones, saves and deletes with their suggestions', async () => {
    const project = await seedProject();
    const quiet = responsibility(project.id);
    const watched = responsibility(project.id, {
      watch: true,
      query: 'label:bug',
      lastScanAt: LATER,
      lastScanStatus: 'completed',
      lastScanMessage: 'Found 1.',
    });
    const paused = responsibility(project.id, { watch: true, paused: true });
    for (const row of [quiet, watched, paused])
      await db.repository.responsibilities.create(scope, row);

    expect(await db.repository.responsibilities.get(scope, watched.id)).toEqual(watched);
    expect(
      (await db.repository.responsibilities.listByProject(scope, project.id)).map((r) => r.id),
    ).toEqual([quiet.id, watched.id, paused.id]);
    expect((await db.repository.responsibilities.listWatched(scope)).map((r) => r.id)).toEqual([
      watched.id,
    ]);

    await db.repository.responsibilities.save(scope, {
      ...quiet,
      title: 'Renamed',
      updatedAt: LATER,
    });
    expect((await db.repository.responsibilities.get(scope, quiet.id))?.title).toBe('Renamed');
    await expect(
      db.repository.responsibilities.save(scope, responsibility(project.id)),
    ).rejects.toThrow(/not stored/);

    await db.repository.suggestions.create(scope, suggestion(watched));
    expect(await db.repository.responsibilities.delete(scope, watched.id)).toBe(true);
    expect(await db.repository.suggestions.listByProject(scope, project.id)).toEqual([]);
    expect(await db.repository.responsibilities.delete(scope, watched.id)).toBe(false);
  });
});

describe('D280 suggestions', () => {
  it('lists newest first by status, finds by fingerprint and refuses a duplicate fingerprint', async () => {
    const project = await seedProject();
    const owner = responsibility(project.id);
    await db.repository.responsibilities.create(scope, owner);
    const first = suggestion(owner);
    const second = suggestion(owner, {
      fingerprint: 'issue:12',
      evidence: [
        { kind: 'github_issue', label: 'Issue #12', url: 'https://github.com/a/b/issues/12' },
      ],
    });
    await db.repository.suggestions.create(scope, first);
    await db.repository.suggestions.create(scope, second);

    expect(
      (await db.repository.suggestions.listByProject(scope, project.id)).map((s) => s.id),
    ).toEqual([second.id, first.id]);
    expect(await db.repository.suggestions.getByFingerprint(scope, project.id, 'issue:12')).toEqual(
      second,
    );
    expect(
      await db.repository.suggestions.getByFingerprint(scope, project.id, 'issue:99'),
    ).toBeNull();
    await expect(
      db.repository.suggestions.create(scope, suggestion(owner, { fingerprint: 'issue:12' })),
    ).rejects.toThrow();

    const taskId = newId();
    await db.repository.suggestions.save(scope, {
      ...first,
      status: 'accepted',
      taskId,
      updatedAt: LATER,
    });
    expect(await db.repository.suggestions.listByProject(scope, project.id, 'accepted')).toEqual([
      { ...first, status: 'accepted', taskId, updatedAt: LATER },
    ]);
  });

  it('refuses a credential in a suggestion', async () => {
    const project = await seedProject();
    const owner = responsibility(project.id);
    await db.repository.responsibilities.create(scope, owner);
    await expect(
      db.repository.suggestions.create(scope, suggestion(owner, { reason: `token ${KEY}` })),
    ).rejects.toBeInstanceOf(SecretWriteRejectedError);
  });
});

describe('D281 team notes', () => {
  it('round-trips, saves, deletes and goes with its project', async () => {
    const project = await seedProject();
    const note: ProjectNote = {
      id: newId(),
      projectId: project.id,
      text: 'Deploys go out on Tuesdays.',
      status: 'unverified',
      source: 'task',
      refId: newId(),
      createdAt: NOW,
      updatedAt: NOW,
    };
    await db.repository.projectNotes.create(scope, note);
    expect(await db.repository.projectNotes.listByProject(scope, project.id)).toEqual([note]);
    await db.repository.projectNotes.save(scope, { ...note, status: 'verified', updatedAt: LATER });
    expect((await db.repository.projectNotes.get(scope, note.id))?.status).toBe('verified');

    await db.repository.projects.delete(scope, project.id);
    expect(await db.repository.projectNotes.get(scope, note.id)).toBeNull();
    expect(await db.repository.projectNotes.delete(scope, note.id)).toBe(false);
  });
});
