import type { Project, Task, TaskSchedule } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { createAceClient } from '../index.js';

/*
 * ACE parity P1 (D275–D278): the task deliverable, GitHub delivery, preview, schedule and clone
 * routes, each through the contract on the way out and on the way back.
 */

const P = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const T = '01ARZ3NDEKTSV4RRFFQ69G5FT0';
const OTHER = '01ARZ3NDEKTSV4RRFFQ69G5FT9';
const S = '01ARZ3NDEKTSV4RRFFQ69G5FT3';
const NOW = '2026-10-07T00:00:00.000Z';

interface Call {
  url: string;
  method: string;
  body: unknown;
}

type Reply = { status?: number; body?: unknown };

function recorder(responses: Reply[]) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const body = init?.body;
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: body === undefined || body === null ? undefined : JSON.parse(String(body)),
    });
    const next = responses.shift() ?? { body: {} };
    const status = next.status ?? 200;
    if (status === 204) return new Response(null, { status });
    return new Response(JSON.stringify(next.body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { calls, client: createAceClient({ baseUrl: 'http://x', token: 't', fetch: fetchImpl }) };
}

const paths = (calls: Call[]): string[] =>
  calls.map((c) => `${c.method} ${c.url.replace('http://x/api/v1', '')}`);

const apiError = (code: string, status: number, message = code) => ({
  status,
  body: { error: { kind: 'workflow', code, message, retryable: false } },
});

const task: Task = {
  id: T,
  projectId: P,
  number: 4,
  title: 'Release notes',
  brief: '',
  type: 'document',
  stage: 'review',
  state: 'idle',
  finishLine: 'accept_document',
  automation: 'assisted',
  priority: 'normal',
  labels: [],
  plan: '',
  acceptance: '',
  runChecks: true,
  paused: false,
  deliverable: { kind: 'document', path: 'docs/notes.md', content: '# Notes' },
  allowedActions: ['approve', 'request_changes', 'accept', 'close', 'pause', 'move', 'delete'],
  createdAt: NOW,
  updatedAt: NOW,
};

const schedule: TaskSchedule = {
  id: S,
  taskId: T,
  trigger: { kind: 'recurring', cron: '0 9 * * 1-5', timezone: 'Europe/London' },
  enabled: true,
  nextRunAt: '2026-10-08T08:00:00.000Z',
  skipped: 0,
  createdAt: NOW,
  updatedAt: NOW,
};

const project: Project = {
  id: P,
  name: 'storefront',
  folderPath: 'D:\\repos\\storefront',
  createdAt: NOW,
  updatedAt: NOW,
};

describe('ACE-P1 D275 deliverables: edit, accept, send', () => {
  it('PUTs the edited draft whole and answers the task', async () => {
    const { calls, client } = recorder([{ body: task }]);
    const deliverable = { kind: 'document' as const, path: 'docs/final.md', content: '# Final' };
    await expect(client.putTaskDeliverable(T, { deliverable })).resolves.toEqual(task);
    expect(paths(calls)).toEqual([`PUT /tasks/${T}/deliverable`]);
    expect(calls[0]?.body).toEqual({ deliverable });
  });

  it('refuses a path outside the project and a bad address before anything is sent', async () => {
    const { calls, client } = recorder([]);
    await expect(
      client.putTaskDeliverable(T, {
        deliverable: { kind: 'document', path: '../secrets.md', content: '' },
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(
      client.putTaskDeliverable(T, {
        deliverable: { kind: 'email', to: ['not-an-address'], cc: [], subject: '', body: '' },
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(client.acceptTask(T, { path: 'C:/notes.md' })).rejects.toMatchObject({
      code: 'validation_failed',
    });
    expect(calls).toHaveLength(0);
  });

  it('accept repeats the path; an email accept sends {}; an existing file answers 409 file_exists', async () => {
    const { calls, client } = recorder([
      { body: { ...task, stage: 'done', state: 'done', outcome: 'accepted' } },
      { body: task },
      apiError('file_exists', 409, 'docs/notes.md already exists in the project folder.'),
    ]);
    await expect(client.acceptTask(T, { path: 'docs/notes.md' })).resolves.toMatchObject({
      outcome: 'accepted',
    });
    await client.acceptTask(T);
    await expect(client.acceptTask(T, { path: 'docs/notes.md' })).rejects.toMatchObject({
      status: 409,
      code: 'file_exists',
      message: 'docs/notes.md already exists in the project folder.',
    });
    expect(paths(calls)).toEqual([
      `POST /tasks/${T}/accept`,
      `POST /tasks/${T}/accept`,
      `POST /tasks/${T}/accept`,
    ]);
    expect(calls.map((call) => call.body)).toEqual([
      { path: 'docs/notes.md' },
      {},
      { path: 'docs/notes.md' },
    ]);
  });

  it('send posts {} and surfaces 422 not_connected', async () => {
    const { calls, client } = recorder([apiError('not_connected', 422)]);
    await expect(client.sendTask(T)).rejects.toMatchObject({ status: 422, code: 'not_connected' });
    expect(paths(calls)).toEqual([`POST /tasks/${T}/send`]);
    expect(calls[0]?.body).toEqual({});
  });
});

describe('ACE-P1 D276 GitHub delivery and clone', () => {
  it('opens a pull request with optional fields, or {}', async () => {
    const { calls, client } = recorder([{ body: task }, { body: task }]);
    await client.openTaskPullRequest(T);
    await client.openTaskPullRequest(T, { title: 'Search', body: 'Why', draft: true });
    expect(paths(calls)).toEqual([`POST /tasks/${T}/open-pr`, `POST /tasks/${T}/open-pr`]);
    expect(calls.map((call) => call.body)).toEqual([
      {},
      { title: 'Search', body: 'Why', draft: true },
    ]);
  });

  it('merges with the method and the confirmed destination; a moved one answers 409', async () => {
    const { calls, client } = recorder([apiError('destination_changed', 409)]);
    const body = { method: 'squash' as const, confirm: { repo: 'acme/shop', base: 'main' } };
    await expect(client.mergeTaskPullRequest(T, body)).rejects.toMatchObject({
      code: 'destination_changed',
    });
    expect(paths(calls)).toEqual([`POST /tasks/${T}/merge-pr`]);
    expect(calls[0]?.body).toEqual(body);
  });

  it('refuses a merge without the confirmation or with an unknown method, unsent', async () => {
    const { calls, client } = recorder([]);
    await expect(
      client.mergeTaskPullRequest(T, { method: 'squash' } as never),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(
      client.mergeTaskPullRequest(T, {
        method: 'fast-forward' as never,
        confirm: { repo: 'acme/shop', base: 'main' },
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    expect(calls).toHaveLength(0);
  });

  it('clones into a new project (201); no signed-in gh answers 422 not_connected', async () => {
    const { calls, client } = recorder([
      { status: 201, body: project },
      apiError('not_connected', 422, 'Run gh auth login in a terminal'),
    ]);
    await expect(client.cloneProject({ repo: 'acme/storefront' })).resolves.toEqual(project);
    await expect(
      client.cloneProject({ repo: 'https://github.com/acme/storefront', name: 'Shop' }),
    ).rejects.toMatchObject({ status: 422, code: 'not_connected' });
    expect(paths(calls)).toEqual(['POST /projects/clone', 'POST /projects/clone']);
    expect(calls.map((call) => call.body)).toEqual([
      { repo: 'acme/storefront' },
      { repo: 'https://github.com/acme/storefront', name: 'Shop' },
    ]);
  });
});

describe('ACE-P1 D278 previews', () => {
  it('starts and stops with {} and answers the task', async () => {
    const { calls, client } = recorder([{ body: task }, { body: task }]);
    await expect(client.startTaskPreview(T)).resolves.toEqual(task);
    await expect(client.stopTaskPreview(T)).resolves.toEqual(task);
    expect(paths(calls)).toEqual([
      `POST /tasks/${T}/preview/start`,
      `POST /tasks/${T}/preview/stop`,
    ]);
    expect(calls.map((call) => call.body)).toEqual([{}, {}]);
  });
});

describe('ACE-P1 D277 schedules', () => {
  it('PUTs the trigger and answers the schedule; DELETE answers 204', async () => {
    const { calls, client } = recorder([{ body: schedule }, { status: 204 }]);
    await expect(
      client.putTaskSchedule(T, { trigger: schedule.trigger, enabled: true }),
    ).resolves.toEqual(schedule);
    await expect(client.deleteTaskSchedule(T)).resolves.toBeUndefined();
    expect(paths(calls)).toEqual([`PUT /tasks/${T}/schedule`, `DELETE /tasks/${T}/schedule`]);
    expect(calls[0]?.body).toEqual({ trigger: schedule.trigger, enabled: true });
  });

  it('sends each trigger kind as written, and surfaces the engine’s reason for a refusal', async () => {
    const { calls, client } = recorder([
      { body: { ...schedule, trigger: { kind: 'after_task', taskId: OTHER } } },
      apiError('validation_failed', 400, 'The time must be in the future.'),
    ]);
    await client.putTaskSchedule(T, { trigger: { kind: 'after_task', taskId: OTHER } });
    await expect(
      client.putTaskSchedule(T, { trigger: { kind: 'once', at: '2020-01-01T00:00:00.000Z' } }),
    ).rejects.toMatchObject({ status: 400, message: 'The time must be in the future.' });
    expect(calls.map((call) => call.body)).toEqual([
      { trigger: { kind: 'after_task', taskId: OTHER } },
      { trigger: { kind: 'once', at: '2020-01-01T00:00:00.000Z' } },
    ]);
  });

  it('refuses a cron that is not five fields before it is sent, and a reply that is not a schedule', async () => {
    const { calls, client } = recorder([{ body: { ...schedule, skipped: -1 } }]);
    await expect(
      client.putTaskSchedule(T, {
        trigger: { kind: 'recurring', cron: '0 9 * *', timezone: 'UTC' },
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    expect(calls).toHaveLength(0);
    await expect(client.putTaskSchedule(T, { trigger: schedule.trigger })).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });
});
