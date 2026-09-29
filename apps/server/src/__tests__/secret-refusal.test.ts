import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ApiErrorSchema, ProjectSchema } from '@ace/contracts';
import { newId } from '@ace/engine';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startEngine, type RunningEngine } from '../server.js';

/**
 * BR-07 / FR-GRD-010 / NFR-USE-03 over the real server: SQLite refuses a key wherever it is typed,
 * and the answer is a 400 that says which field, never a bare 500 and never the key.
 *
 * Every key-shaped value is assembled at runtime (CLAUDE.md §2).
 */

const ANTHROPIC_KEY = ['sk', '-ant-', 'api03', '-', 'FAKE'.repeat(5), '0000'].join('');
const GITHUB_KEY = ['ghp', '_', 'a1B2'.repeat(9)].join('');

let dir: string;
let engine: RunningEngine;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ace-secret-refusal-'));
  engine = await startEngine({ dataDir: dir, port: 0, env: {} });
});

afterEach(async () => {
  await engine.stop();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows can still hold the SQLite WAL handle for a moment; the OS reclaims temp itself.
  }
});

async function api(path: string, method: string, body: unknown): Promise<Response> {
  return fetch(`${engine.url}/api/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${engine.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function newProject(): Promise<string> {
  const response = await api('/projects', 'POST', { name: 'Secrets', folderPath: join(dir, 'p') });
  expect(response.status).toBe(201);
  return ProjectSchema.parse(await response.json()).id;
}

/** The refusal, parsed; and the raw body, which must not hold the key anywhere. */
async function refusal(response: Response, key: string) {
  const raw = await response.text();
  expect(response.status, raw).toBe(400);
  expect(raw).not.toContain(key);
  return ApiErrorSchema.parse(JSON.parse(raw)).error;
}

describe('BR-07 NFR-USE-03 a key pasted into a node is refused, and the answer says where', () => {
  it('answers a graph-ops add_node with a key in its instructions 400, naming the field', async () => {
    const projectId = await newProject();
    const workflow = (await (
      await api(`/projects/${projectId}/workflows`, 'POST', { name: 'Flow 1' })
    ).json()) as { id: string };

    const node = {
      id: newId(),
      workflowId: workflow.id,
      kind: 'agent',
      name: 'Writer',
      position: { x: 0, y: 0 },
      inputs: [],
      outputs: [],
      config: {
        instructions: `Call the API with ${ANTHROPIC_KEY}.`,
        inputTypes: ['text'],
        outputTypes: ['text'],
      },
    };

    const error = await refusal(
      await api(`/workflows/${workflow.id}/graph-ops`, 'POST', {
        baseVersion: 0,
        ops: [{ op: 'add_node', node }],
      }),
      ANTHROPIC_KEY,
    );

    expect(error.code).toBe('validation_failed');
    expect(error.message).toContain('"instructions"');
    expect(error.details).toEqual({ path: expect.stringContaining('instructions') });

    // Nothing was stored: the graph is still empty and still at version 0.
    const graph = (await (
      await fetch(`${engine.url}/api/v1/workflows/${workflow.id}`, {
        headers: { Authorization: `Bearer ${engine.token}` },
      })
    ).json()) as { workflow: { version: number }; nodes: unknown[] };
    expect(graph.workflow.version).toBe(0);
    expect(graph.nodes).toEqual([]);
  });

  it('answers PATCH /settings with a key in it 400', async () => {
    const error = await refusal(
      await api('/settings', 'PATCH', {
        allowedOrigins: ['http://localhost:5173', `https://example.test/${GITHUB_KEY}`],
      }),
      GITHUB_KEY,
    );

    expect(error.code).toBe('validation_failed');
    expect(error.message).toContain('"allowedOrigins"');
  });

  it('answers a policy whose check params hold a key 400', async () => {
    const projectId = await newProject();

    const error = await refusal(
      await api('/guardrail-policies', 'POST', {
        projectId,
        name: 'Strict',
        checks: [
          {
            id: newId(),
            point: 'input',
            type: 'blocked_topics',
            action: 'block',
            enabled: true,
            params: { patterns: [GITHUB_KEY] },
          },
        ],
      }),
      GITHUB_KEY,
    );

    expect(error.code).toBe('validation_failed');
    expect(error.message).toContain('"patterns"');
  });
});

describe('BR-07 a key used as a policy name or a field name is refused over the API', () => {
  it('answers a policy named with a key 400, and stores no such policy', async () => {
    const projectId = await newProject();

    const error = await refusal(
      await api('/guardrail-policies', 'POST', { projectId, name: GITHUB_KEY, checks: [] }),
      GITHUB_KEY,
    );
    expect(error.code).toBe('validation_failed');
    expect(error.message).toContain('"name"');

    const listed = await fetch(`${engine.url}/api/v1/guardrail-policies?projectId=${projectId}`, {
      headers: { Authorization: `Bearer ${engine.token}` },
    });
    expect(await listed.text()).not.toContain(GITHUB_KEY);
  });

  it('answers a check whose params use a key as a field name 400, without echoing it', async () => {
    const projectId = await newProject();

    const error = await refusal(
      await api('/guardrail-policies', 'POST', {
        projectId,
        name: 'Strict',
        checks: [
          {
            id: newId(),
            point: 'input',
            type: 'size_limit',
            action: 'warn',
            enabled: true,
            params: { [GITHUB_KEY]: true },
          },
        ],
      }),
      GITHUB_KEY,
    );
    expect(error.code).toBe('validation_failed');
  });
});
