import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AssistantApplyResponseSchema,
  AssistantProposalSchema,
  SuggestionListResponseSchema,
  TaskDetailSchema,
  TaskSchema,
  WorkflowGraphResponseSchema,
  type TaskDetail,
} from '@ace/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startEngine, type RunningEngine } from '../server.js';

/*
 * ACE parity P1/P2 on the real engine and real Git: a Document task accepted into the project
 * folder (never over a file), a live preview of a task's worktree, a Software health scan whose
 * suggestion becomes an Inbox task, an email import, team notes reaching a run, and the Assistant
 * setting a team up. GitHub delivery is covered with a fake gh in the tools and engine suites.
 */

const gitAvailable = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
})();

let root: string;
let engine: RunningEngine;

function sh(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
}

const api = async (path: string, init: { method?: string; body?: unknown } = {}) => {
  const response = await fetch(`${engine.url}/api/v1${path}`, {
    method: init.method ?? 'GET',
    headers: { Authorization: `Bearer ${engine.token}`, 'Content-Type': 'application/json' },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? undefined : (JSON.parse(text) as unknown) };
};

const detailOf = async (id: string): Promise<TaskDetail> =>
  TaskDetailSchema.parse((await api(`/tasks/${id}`)).body);

async function until<T>(
  what: string,
  read: () => Promise<T>,
  done: (value: T) => boolean,
  ms = 60_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await read();
    if (done(last)) return last;
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  throw new Error(`timed out waiting for ${what}; last: ${JSON.stringify(last)}`);
}

async function setUp(): Promise<{ projectId: string; repo: string; teamId: string }> {
  const repo = join(root, 'shop');
  mkdirSync(repo, { recursive: true });
  sh(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), '# Shop\n');
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-q', '-m', 'base');
  const project = (
    await api('/projects', { method: 'POST', body: { name: 'Shop', folderPath: repo } })
  ).body as { id: string };
  const provider = (
    await api('/providers', { method: 'POST', body: { type: 'mock', name: 'Mock' } })
  ).body as { id: string };
  await api(`/providers/${provider.id}/refresh-models`, { method: 'POST' });
  const team = (
    await api('/templates/single-builder/instantiate', {
      method: 'POST',
      body: { projectId: project.id },
    })
  ).body as { workflow: { id: string } };
  return { projectId: project.id, repo, teamId: team.workflow.id };
}

const reviewed = (detail: TaskDetail) =>
  detail.task.stage === 'review' || detail.task.state === 'failed';

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'ace-p1p2-'));
  engine = await startEngine({ dataDir: join(root, 'data'), port: 0, env: {} });
});

afterEach(async () => {
  await engine.stop();
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch {
    // Windows can hold the WAL a moment longer.
  }
});

describe.skipIf(!gitAvailable)('ACE parity P1 on the real engine', () => {
  it('accepts a Document into the project folder and never over an existing file', async () => {
    const { projectId, repo, teamId } = await setUp();
    const create = (path: string) =>
      api(`/projects/${projectId}/tasks`, {
        method: 'POST',
        body: {
          title: 'Write the notes',
          type: 'document',
          documentPath: path,
          finishLine: 'accept_document',
          workflowId: teamId,
          start: 'now',
        },
      });
    const task = TaskSchema.parse((await create('docs/notes.md')).body);
    const ready = await until('review', () => detailOf(task.id), reviewed);
    expect(ready.task.stage, ready.task.stateReason).toBe('review');
    expect(ready.workspace).toBeUndefined();
    expect(ready.task.deliverable).toMatchObject({ kind: 'document', path: 'docs/notes.md' });

    const accepted = await api(`/tasks/${task.id}/accept`, {
      method: 'POST',
      body: { path: 'docs/notes.md' },
    });
    expect(TaskSchema.parse(accepted.body)).toMatchObject({ stage: 'done', outcome: 'accepted' });
    const deliverable = ready.task.deliverable;
    expect(readFileSync(join(repo, 'docs', 'notes.md'), 'utf8')).toBe(
      deliverable?.kind === 'document' ? deliverable.content : '',
    );

    const second = TaskSchema.parse((await create('docs/notes.md')).body);
    await until('review', () => detailOf(second.id), reviewed);
    const refused = await api(`/tasks/${second.id}/accept`, { method: 'POST', body: {} });
    expect(refused.status).toBe(409);
    expect((refused.body as { error: { code: string } }).error.code).toBe('file_exists');
  }, 120_000);

  it("previews a task's worktree on a free port and stops it", async () => {
    const { projectId, teamId } = await setUp();
    await api(`/projects/${projectId}`, {
      method: 'PATCH',
      body: {
        previewCommand: `node -e "require('http').createServer((q,s)=>s.end('preview ok')).listen(process.env.PORT)"`,
        previewUrl: 'http://127.0.0.1:{port}',
      },
    });
    const task = TaskSchema.parse(
      (
        await api(`/projects/${projectId}/tasks`, {
          method: 'POST',
          body: { title: 'Look at it', workflowId: teamId, start: 'now' },
        })
      ).body,
    );
    const ready = await until('review', () => detailOf(task.id), reviewed);
    expect(ready.task.allowedActions).toContain('preview');

    expect((await api(`/tasks/${task.id}/preview/start`, { method: 'POST' })).status).toBe(200);
    const preview = (await detailOf(task.id)).preview;
    expect(preview).toMatchObject({ status: 'running' });
    const page = await until(
      'the preview to answer',
      async () => {
        try {
          return await (await fetch(preview?.url ?? '')).text();
        } catch {
          return '';
        }
      },
      (text) => text === 'preview ok',
      30_000,
    );
    expect(page).toBe('preview ok');

    await api(`/tasks/${task.id}/preview/stop`, { method: 'POST' });
    const stopped = await until(
      'the preview to stop',
      () => detailOf(task.id),
      (d) => d.preview?.status === 'stopped',
    );
    expect(stopped.preview?.status).toBe('stopped');
  }, 120_000);
});

describe.skipIf(!gitAvailable)('ACE parity P2 on the real engine', () => {
  it('scans for a failing check, and an accepted suggestion becomes an Inbox task', async () => {
    const { projectId, teamId } = await setUp();
    await api(`/projects/${projectId}`, {
      method: 'PATCH',
      body: { checkCommands: [{ name: 'always fails', command: 'node -e "process.exit(3)"' }] },
    });
    const task = TaskSchema.parse(
      (
        await api(`/projects/${projectId}/tasks`, {
          method: 'POST',
          body: { title: 'Break it', workflowId: teamId, start: 'now' },
        })
      ).body,
    );
    await until('review', () => detailOf(task.id), reviewed);

    const owner = (
      await api(`/projects/${projectId}/responsibilities`, {
        method: 'POST',
        body: {
          kind: 'software_health',
          title: 'Keep checks green',
          goodWork: 'Every check passes.',
        },
      })
    ).body as { id: string };
    expect(
      SuggestionListResponseSchema.parse((await api(`/projects/${projectId}/suggestions`)).body)
        .items,
    ).toEqual([]);
    await api(`/responsibilities/${owner.id}/scan`, { method: 'POST' });
    const found = await until(
      'a suggestion',
      async () =>
        SuggestionListResponseSchema.parse((await api(`/projects/${projectId}/suggestions`)).body)
          .items,
      (items) => items.length > 0,
    );
    expect(found[0]).toMatchObject({
      title: 'Fix the failing "always fails" check on task #1',
      status: 'new',
    });

    const accepted = await api(`/suggestions/${found[0]?.id ?? ''}/accept`, {
      method: 'POST',
      body: {},
    });
    const inbox = await detailOf((accepted.body as { taskId: string }).taskId);
    expect(inbox.task).toMatchObject({ stage: 'inbox', state: 'idle', finishLine: 'review' });
    expect(inbox.executions).toEqual([]);
  }, 120_000);

  it('imports an email, gives runs the team notes, and sets a team up with the Assistant', async () => {
    const { projectId, teamId } = await setUp();
    const imported = await api(`/projects/${projectId}/tasks/import-email`, {
      method: 'POST',
      body: {
        raw: 'From: Ann <ann@example.com>\r\nSubject: Search is slow\r\n\r\nIt takes 3 s.',
        workflowId: teamId,
      },
    });
    expect(imported.status).toBe(201);
    const fromMail = TaskSchema.parse(imported.body);
    expect(fromMail).toMatchObject({ title: 'Search is slow', stage: 'inbox' });

    await api(`/projects/${projectId}/notes`, {
      method: 'POST',
      body: { text: 'Search lives in src/search.ts.' },
    });
    await api(`/tasks/${fromMail.id}/start`, { method: 'POST' });
    const running = await until(
      'a run',
      () => detailOf(fromMail.id),
      (d) => d.executions[0]?.runId !== undefined,
    );
    const run = (await api(`/runs/${running.executions[0]?.runId ?? ''}`)).body as {
      inputs: unknown;
    };
    expect(JSON.stringify(run.inputs)).toContain('## Team notes');
    expect(JSON.stringify(run.inputs)).toContain('Search lives in src/search.ts.');

    const proposal = AssistantProposalSchema.parse(
      (
        await api('/assistant/propose', {
          method: 'POST',
          body: {
            prompt:
              'Build a booking app. Have one agent plan it and another review it, $2 per run.',
          },
        })
      ).body,
    );
    expect(proposal).toMatchObject({
      team: 'plan-build-review',
      projectName: 'Booking app',
      source: 'rules',
    });
    const applied = AssistantApplyResponseSchema.parse(
      (
        await api('/assistant/apply', {
          method: 'POST',
          body: {
            proposal: {
              ...proposal,
              agents: proposal.agents.map((a) => ({ ...a, name: `${a.name} One` })),
            },
            folderPath: join(root, 'booking'),
          },
        })
      ).body,
    );
    expect(applied.project).toMatchObject({ name: 'Booking app', maxCostPerRunUsd: 2 });
    expect(existsSync(join(root, 'booking'))).toBe(true);
    const graph = WorkflowGraphResponseSchema.parse(
      (await api(`/workflows/${applied.workflow.id}`)).body,
    );
    expect(
      graph.nodes
        .filter((node) => node.kind === 'agent')
        .map((node) => node.name)
        .sort(),
    ).toEqual(['Builder One', 'Planner One', 'Reviewer One']);
  }, 120_000);
});
