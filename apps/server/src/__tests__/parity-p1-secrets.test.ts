import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AgentConfigSchema,
  PendingApprovalListResponseSchema,
  RunSchema,
  SecretListResponseSchema,
  SecretSchema,
  TaskDetailSchema,
  TaskSchema,
  type Run,
  type TaskDetail,
} from '@ace/contracts';
import type { Scope, SecretStore } from '@ace/engine';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { cliPermissionCeiling, startEngine, type RunningEngine } from '../server.js';
import { graphBuilder } from './round5-harness.js';

/*
 * ACE parity P1 on the real engine (D274, D270): secrets go in through `/secrets`, their values
 * only into the injected store (never this machine's keychain), every persisted event and stored
 * check output is scrubbed of them, a project's check commands receive them, the approvals inbox
 * answers, and the approval mode sets the ceiling of a CLI provider's permission preset.
 */

/** Obviously fake, and shaped like no credential, so only the exact-value scrubber can catch it. */
const VALUE = 'fake-deploy-value-0001';

const gitAvailable = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
})();

/** An in-memory keychain: what was written, by key. */
function memoryStore(): SecretStore & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  const at = (scope: Scope, key: string) => `${scope.workspaceId}:${key}`;
  return {
    entries,
    isAvailable: async () => true,
    get: async (scope, key) => entries.get(at(scope, key)) ?? null,
    set: async (scope, key, value) => {
      entries.set(at(scope, key), value);
    },
    delete: async (scope, key) => entries.delete(at(scope, key)),
  };
}

let root: string;
let store: ReturnType<typeof memoryStore>;
let engine: RunningEngine;

const api = async (path: string, init: { method?: string; body?: unknown } = {}) => {
  const response = await fetch(`${engine.url}/api/v1${path}`, {
    method: init.method ?? 'GET',
    headers: { Authorization: `Bearer ${engine.token}`, 'Content-Type': 'application/json' },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    text,
    body: text === '' ? undefined : (JSON.parse(text) as unknown),
  };
};

async function until<T>(what: string, read: () => Promise<T>, done: (value: T) => boolean) {
  const deadline = Date.now() + 60_000;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await read();
    if (done(last)) return last;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`timed out waiting for ${what}; last: ${JSON.stringify(last)}`);
}

async function createProject(name: string, folderPath = join(root, name)) {
  mkdirSync(folderPath, { recursive: true });
  return (await api('/projects', { method: 'POST', body: { name, folderPath } })).body as {
    id: string;
  };
}

async function mockProvider(): Promise<string> {
  const provider = (await api('/providers', { method: 'POST', body: { type: 'mock', name: 'M' } }))
    .body as { id: string };
  await api(`/providers/${provider.id}/refresh-models`, { method: 'POST' });
  return provider.id;
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'ace-p1-secrets-'));
  store = memoryStore();
  engine = await startEngine({ dataDir: join(root, 'data'), port: 0, env: {}, secretStore: store });
});

afterEach(async () => {
  await engine.stop();
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch {
    // Windows can hold the WAL a moment longer.
  }
});

describe('D270 the approval mode is the ceiling of a CLI provider’s permission preset', () => {
  it('caps at edit_files under Ask (and before any choice), and not at all otherwise', () => {
    expect(cliPermissionCeiling(undefined)).toBe('edit_files');
    expect(cliPermissionCeiling('ask')).toBe('edit_files');
    expect(cliPermissionCeiling('auto_review')).toBeUndefined();
    expect(cliPermissionCeiling('full_access')).toBeUndefined();
  });
});

describe('D270 the approvals inbox on the real engine', () => {
  it('answers GET /approvals with every pending approval, none yet', async () => {
    const response = await api('/approvals');
    expect(response.status).toBe(200);
    expect(PendingApprovalListResponseSchema.parse(response.body)).toEqual({ items: [] });
  });
});

describe('D274 secrets on the real engine', () => {
  it('keeps the value in the injected keychain only, and never answers it', async () => {
    const project = await createProject('shop');
    const created = await api('/secrets', {
      method: 'POST',
      body: { name: 'DEPLOY_TOKEN', value: VALUE, projectIds: [project.id] },
    });
    expect(created.status).toBe(201);
    expect(created.text).not.toContain(VALUE);
    expect(SecretSchema.parse(created.body).projectIds).toEqual([project.id]);
    expect(store.entries.get('local:secret:env:DEPLOY_TOKEN')).toBe(VALUE);

    const listed = await api('/secrets');
    expect(listed.text).not.toContain(VALUE);
    expect(SecretListResponseSchema.parse(listed.body).items.map((s) => s.name)).toEqual([
      'DEPLOY_TOKEN',
    ]);
    expect(await engine.services.secrets.envFor(project.id)).toEqual({ DEPLOY_TOKEN: VALUE });

    const reserved = await api('/secrets', {
      method: 'POST',
      body: { name: 'PATH', value: VALUE },
    });
    expect(reserved.status).toBe(400);
    expect(reserved.text).not.toContain(VALUE);

    expect((await api('/secrets/DEPLOY_TOKEN', { method: 'DELETE' })).status).toBe(204);
    expect(store.entries.size).toBe(0);
  });

  it('scrubs the exact value out of every event a run persists', async () => {
    const project = await createProject('scrubbed');
    const providerId = await mockProvider();
    expect(
      (await api('/secrets', { method: 'POST', body: { name: 'DEPLOY_TOKEN', value: VALUE } }))
        .status,
    ).toBe(201);

    const builder = graphBuilder('Echo');
    const input = builder.add('input', 'Input', {
      text: `Deploy with ${VALUE} now.`,
      artifactIds: [],
      outputTypes: ['text'],
    });
    // `mock-json` answers with the whole prompt it was sent, so the value is in its output.
    const echo = builder.add(
      'agent',
      'Echo',
      AgentConfigSchema.parse({
        providerId,
        modelId: 'mock-json',
        instructions: 'Echo it.',
        inputTypes: ['text'],
        outputTypes: ['json'],
      }),
    );
    const output = builder.add('output', 'Output', {});
    builder.connect(input, echo);
    builder.connect(echo, output);
    const graph = (
      await api(`/projects/${project.id}/workflows/import`, {
        method: 'POST',
        body: builder.export(),
      })
    ).body as { workflow: { id: string } };

    const started = RunSchema.parse(
      (await api(`/workflows/${graph.workflow.id}/runs`, { method: 'POST', body: {} })).body,
    );
    const ended: Run = await until(
      'the run to end',
      async () => RunSchema.parse((await api(`/runs/${started.id}`)).body),
      (run) => !['PREFLIGHT', 'RUNNING', 'PAUSED'].includes(run.status),
    );
    expect(ended.status).toBe('COMPLETE');

    const events = await api(`/runs/${started.id}/events`);
    expect(events.text).not.toContain(VALUE);
    const nodeOutput = (events.body as { type: string; payload: unknown }[]).find(
      (event) => event.type === 'node.output' && JSON.stringify(event.payload).includes('Echo it'),
    );
    expect(JSON.stringify(nodeOutput?.payload)).toContain('[SECRET:DEPLOY_TOKEN]');
  });

  describe.skipIf(!gitAvailable)('a project’s check commands', () => {
    function sh(cwd: string, ...args: string[]): void {
      execFileSync(
        'git',
        [
          '-c',
          'user.name=Test',
          '-c',
          'user.email=test@example.com',
          '-c',
          'commit.gpgsign=false',
          ...args,
        ],
        { cwd, stdio: 'ignore', windowsHide: true },
      );
    }

    it('run with the secrets in scope, and their output is stored scrubbed', async () => {
      const repo = join(root, 'shop');
      mkdirSync(repo, { recursive: true });
      sh(repo, 'init', '-q', '-b', 'main');
      writeFileSync(join(repo, 'README.md'), '# Shop\n');
      sh(repo, 'add', '-A');
      sh(repo, 'commit', '-q', '-m', 'base');
      const project = await createProject('shop', repo);
      const other = await createProject('other');
      await mockProvider();
      const team = (
        await api('/templates/single-builder/instantiate', {
          method: 'POST',
          body: { projectId: project.id },
        })
      ).body as { workflow: { id: string } };

      await api('/secrets', {
        method: 'POST',
        body: { name: 'DEPLOY_TOKEN', value: VALUE, projectIds: [project.id] },
      });
      await api('/secrets', {
        method: 'POST',
        body: { name: 'OTHER_TOKEN', value: 'fake-other-value-0002', projectIds: [other.id] },
      });
      await api(`/projects/${project.id}`, {
        method: 'PATCH',
        body: {
          checkCommands: [
            {
              name: 'env',
              command: `node -e "process.stdout.write([process.env.DEPLOY_TOKEN, process.env.OTHER_TOKEN || 'no-other'].join(' '))"`,
            },
          ],
        },
      });

      const created = await api(`/projects/${project.id}/tasks`, {
        method: 'POST',
        body: {
          title: 'Check the env',
          brief: 'ace-mock:write notes.md\nhello\nace-mock:end',
          workflowId: team.workflow.id,
          start: 'now',
        },
      });
      const task = TaskSchema.parse(created.body);
      const detail: TaskDetail = await until(
        'the checks',
        async () => TaskDetailSchema.parse((await api(`/tasks/${task.id}`)).body),
        (d) => d.checks.length > 0 || d.task.state === 'failed',
      );

      const check = detail.checks.find((row) => row.name === 'env');
      expect(check?.output).toBe('[SECRET:DEPLOY_TOKEN] no-other');
      expect(JSON.stringify(detail)).not.toContain(VALUE);
    });
  });
});
