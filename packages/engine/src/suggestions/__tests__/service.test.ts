import type { ProjectNote, Responsibility, Suggestion } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { HttpError } from '../../gateway/errors.js';
import { createLogger } from '../../logging/index.js';
import type {
  ProjectNoteRepository,
  ResponsibilityRepository,
  SuggestionRepository,
} from '../../ports/index.js';
import { createTaskHarness, file, type TaskHarness } from '../../tasks/__tests__/harness.js';
import { createSuggestionService, type SuggestionService } from '../service.js';

const clone = <T>(value: T): T => structuredClone(value);

class InMemorySuggestionRepos {
  readonly responsibilityRows = new Map<string, Responsibility>();
  readonly suggestionRows = new Map<string, Suggestion>();
  readonly noteRows = new Map<string, ProjectNote>();

  readonly responsibilities: ResponsibilityRepository = {
    create: async (_s, row) => {
      this.responsibilityRows.set(row.id, clone(row));
      return clone(row);
    },
    get: async (_s, id) => clone(this.responsibilityRows.get(id) ?? null),
    listByProject: async (_s, projectId) =>
      [...this.responsibilityRows.values()].filter((row) => row.projectId === projectId).map(clone),
    listWatched: async () =>
      [...this.responsibilityRows.values()].filter((row) => row.watch && !row.paused).map(clone),
    save: async (_s, row) => {
      this.responsibilityRows.set(row.id, clone(row));
      return clone(row);
    },
    delete: async (_s, id) => {
      for (const [key, row] of this.suggestionRows) {
        if (row.responsibilityId === id && row.status !== 'accepted')
          this.suggestionRows.delete(key);
      }
      return this.responsibilityRows.delete(id);
    },
  };

  readonly suggestions: SuggestionRepository = {
    create: async (_s, row) => {
      this.suggestionRows.set(row.id, clone(row));
      return clone(row);
    },
    get: async (_s, id) => clone(this.suggestionRows.get(id) ?? null),
    listByProject: async (_s, projectId, status) =>
      [...this.suggestionRows.values()]
        .filter(
          (row) => row.projectId === projectId && (status === undefined || row.status === status),
        )
        .reverse()
        .map(clone),
    getByFingerprint: async (_s, projectId, fingerprint) =>
      clone(
        [...this.suggestionRows.values()].find(
          (row) => row.projectId === projectId && row.fingerprint === fingerprint,
        ) ?? null,
      ),
    save: async (_s, row) => {
      this.suggestionRows.set(row.id, clone(row));
      return clone(row);
    },
  };

  readonly notes: ProjectNoteRepository = {
    create: async (_s, row) => {
      this.noteRows.set(row.id, clone(row));
      return clone(row);
    },
    get: async (_s, id) => clone(this.noteRows.get(id) ?? null),
    listByProject: async (_s, projectId) =>
      [...this.noteRows.values()].filter((row) => row.projectId === projectId).map(clone),
    save: async (_s, row) => {
      this.noteRows.set(row.id, clone(row));
      return clone(row);
    },
    delete: async (_s, id) => this.noteRows.delete(id),
  };
}

async function setUp(): Promise<{
  h: TaskHarness;
  s: SuggestionService;
  repos: InMemorySuggestionRepos;
}> {
  const h = await createTaskHarness();
  const repos = new InMemorySuggestionRepos();
  Object.assign(h.repository, {
    responsibilities: repos.responsibilities,
    suggestions: repos.suggestions,
    projectNotes: repos.notes,
  });
  const s = createSuggestionService({
    repository: h.repository,
    scope: { workspaceId: 'local' },
    bus: h.bus,
    logger: createLogger({ level: 'silent', destination: { write: () => undefined } }),
    createTask: (projectId, body) => h.service.create(projectId, body),
    git: h.git,
    github: h.github,
    mask: (text) => text.replace(/sk-[a-z0-9]+/g, '[REDACTED]'),
  });
  return { h, s, repos };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpError) return error.code;
    throw error;
  }
  throw new Error('expected a refusal');
}

/** A task in review whose `tests` check failed on its head. */
async function failingCheck(h: TaskHarness): Promise<string> {
  await h.repository.projects.update({ workspaceId: 'local' }, h.project.id, {
    checkCommands: [{ name: 'tests', command: 'pnpm test' }],
    updatedAt: new Date().toISOString(),
  });
  h.commands.results.set('pnpm test', { exitCode: 1, output: '1 failed, token sk-abc123' });
  const task = await h.service.create(h.project.id, {
    title: 'Search',
    workflowId: h.team.id,
    start: 'now',
  });
  await h.settle();
  await h.finishRun(h.lastRunId(), 'COMPLETE', { text: 'ok', changes: [file('a.ts')] });
  return task.id;
}

describe('D280 responsibilities scan only when asked', () => {
  it('saving a responsibility scans nothing; Scan now finds the failing check once', async () => {
    const { h, s } = await setUp();
    const taskId = await failingCheck(h);
    const owner = await s.createResponsibility(h.project.id, {
      kind: 'software_health',
      title: 'Keep the checks green',
      goodWork: 'Every check passes.',
    });
    expect(await s.listSuggestions(h.project.id, {})).toEqual([]);

    const running = await s.scan(owner.id);
    expect(running.lastScanStatus).toBe('running');
    await s.idle();
    const found = await s.listSuggestions(h.project.id, {});
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      title: 'Fix the failing "tests" check on task #1',
      status: 'new',
      completionCriteria: 'Every check passes.',
      fingerprint: `check:${taskId}:tests`,
    });
    expect(found[0]?.evidence[0]?.detail).toBe('1 failed, token [REDACTED]');
    expect((await s.listResponsibilities(h.project.id))[0]).toMatchObject({
      lastScanStatus: 'completed',
      lastScanMessage: 'Found 1 new suggestion.',
    });

    // A second scan finds nothing new — and never brings back a dismissed one.
    await s.dismiss(found[0]?.id ?? '');
    await s.scan(owner.id);
    await s.idle();
    expect(await s.listSuggestions(h.project.id, {})).toHaveLength(1);
    expect((await s.listResponsibilities(h.project.id))[0]?.lastScanMessage).toBe(
      'Nothing new worth doing was found.',
    );
    expect(h.events.some((event) => event.type === 'project.changed')).toBe(true);
  });

  it('adds GitHub issues and failed runs when the repository is on GitHub', async () => {
    const { h, s } = await setUp();
    h.git.status = { ...h.git.status, remoteUrl: 'https://github.com/acme/shop.git' };
    h.github.issues = [
      {
        number: 12,
        title: 'Search is slow',
        url: 'https://github.com/acme/shop/issues/12',
        body: 'Takes 3 s.',
        labels: ['bug'],
      },
    ];
    h.github.runs = [
      {
        id: 9,
        name: 'CI',
        url: 'https://github.com/acme/shop/actions/runs/9',
        branch: 'main',
        createdAt: '2026-10-06T10:00:00Z',
      },
    ];
    const owner = await s.createResponsibility(h.project.id, {
      kind: 'software_health',
      title: 'Health',
    });
    await s.scan(owner.id);
    await s.idle();
    const found = await s.listSuggestions(h.project.id, {});
    expect(found.map((row) => row.fingerprint).sort()).toEqual(['issue:12', 'run:CI:main']);
    expect(found.find((row) => row.fingerprint === 'issue:12')?.evidence[0]).toMatchObject({
      kind: 'github_issue',
      url: 'https://github.com/acme/shop/issues/12',
    });
  });

  it('refuses a second scan at once, an email responsibility, and cancels a scan', async () => {
    const { h, s } = await setUp();
    const mail = await s.createResponsibility(h.project.id, {
      kind: 'email',
      title: 'Sponsors',
      query: 'sponsor',
    });
    expect(await codeOf(s.scan(mail.id))).toBe('not_connected');
    const owner = await s.createResponsibility(h.project.id, {
      kind: 'software_health',
      title: 'Health',
    });
    await s.scan(owner.id);
    expect(await codeOf(s.scan(owner.id))).toBe('scan_running');
    const cancelled = await s.cancelScan(owner.id);
    expect(['cancelled', 'completed']).toContain(cancelled.lastScanStatus);
  });

  it('watches on a timer only when asked, and never while paused', async () => {
    const { h, s } = await setUp();
    await failingCheck(h);
    const owner = await s.createResponsibility(h.project.id, {
      kind: 'software_health',
      title: 'Health',
    });
    await s.watchTick();
    await s.idle();
    expect(await s.listSuggestions(h.project.id, {})).toHaveLength(0);

    await s.updateResponsibility(owner.id, { watch: true, paused: true });
    await s.watchTick();
    await s.idle();
    expect(await s.listSuggestions(h.project.id, {})).toHaveLength(0);

    await s.updateResponsibility(owner.id, { paused: false });
    await s.watchTick();
    await s.idle();
    expect(await s.listSuggestions(h.project.id, {})).toHaveLength(1);
  });
});

describe('D280 deciding on a suggestion', () => {
  it('Add to Inbox creates an Inbox task that keeps a review step and starts nothing', async () => {
    const { h, s } = await setUp();
    await failingCheck(h);
    const owner = await s.createResponsibility(h.project.id, {
      kind: 'software_health',
      title: 'Health',
    });
    await s.scan(owner.id);
    await s.idle();
    const [found] = await s.listSuggestions(h.project.id, {});
    const runsBefore = h.runs.size;
    const accepted = await s.accept(found?.id ?? '', { workflowId: h.team.id });
    expect(accepted.status).toBe('accepted');
    const task = (await h.service.get(accepted.taskId ?? '')).task;
    expect(task).toMatchObject({ stage: 'inbox', state: 'idle', finishLine: 'review' });
    expect(task.source).toEqual({ kind: 'suggestion', refId: found?.id, label: 'Health' });
    expect(task.brief).toContain('Evidence:');
    expect(h.runs.size).toBe(runsBefore);
    expect(await codeOf(s.accept(found?.id ?? '', {}))).toBe('invalid_task_state');
  });

  it('Later keeps it, Dismiss is final', async () => {
    const { h, s } = await setUp();
    await failingCheck(h);
    const owner = await s.createResponsibility(h.project.id, {
      kind: 'software_health',
      title: 'Health',
    });
    await s.scan(owner.id);
    await s.idle();
    const [found] = await s.listSuggestions(h.project.id, {});
    expect((await s.later(found?.id ?? '')).status).toBe('later');
    expect(await s.listSuggestions(h.project.id, { status: 'later' })).toHaveLength(1);
    expect((await s.dismiss(found?.id ?? '')).status).toBe('dismissed');
    expect(await codeOf(s.later(found?.id ?? ''))).toBe('invalid_task_state');
  });
});

describe('D281 team notes and D282 email import', () => {
  it('keeps notes verified when written by hand, and confirms an automatic one on correction', async () => {
    const { h, s } = await setUp();
    const mine = await s.createNote(h.project.id, { text: 'Deploys go out on Tuesdays.' });
    const auto = await s.createNote(h.project.id, {
      text: 'Search uses Postgres FTS.',
      source: 'task',
    });
    expect([mine.status, auto.status]).toEqual(['verified', 'unverified']);
    const corrected = await s.updateNote(auto.id, { text: 'Search uses SQLite FTS5.' });
    expect(corrected).toMatchObject({ status: 'verified', text: 'Search uses SQLite FTS5.' });
    await s.deleteNote(mine.id);
    expect((await s.listNotes(h.project.id)).map((note) => note.id)).toEqual([auto.id]);
  });

  it('imports an email as an Inbox task with its sender, never starting it', async () => {
    const { h, s } = await setUp();
    const task = await s.importEmail(h.project.id, {
      raw: 'From: Ann <ann@example.com>\r\nSubject: Search is slow\r\nDate: Tue, 6 Oct 2026\r\n\r\nIt takes 3 s.',
    });
    expect(task).toMatchObject({ title: 'Search is slow', stage: 'inbox', state: 'idle' });
    expect(task.brief).toContain('From: Ann <ann@example.com>');
    expect(task.brief).toContain('It takes 3 s.');
    expect(task.source).toEqual({ kind: 'email', label: 'Ann <ann@example.com>' });
    expect(h.runs.size).toBe(0);
  });
});
