import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CliDetection } from '@ace/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startEngine, type RunningEngine } from '../server.js';

const scan: CliDetection[] = [
  { type: 'claude_code', installed: true, version: '0.0.0-fake-scan', login: 'logged_in', loginDetail: 'claude.ai', installHint: 'npm install -g @anthropic-ai/claude-code', loginHint: 'claude auth login' },
  { type: 'codex_cli', installed: false, login: 'unknown', installHint: 'npm install -g @openai/codex', loginHint: 'codex login' },
  { type: 'gemini_cli', installed: false, login: 'unknown', installHint: 'npm install -g @google/gemini-cli', loginHint: 'gemini' },
];

let dir: string;
let engine: RunningEngine;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ace-x1-server-'));
  engine = await startEngine({
    dataDir: dir,
    port: 0,
    env: {},
    cliDetector: {
      detect: async (type) => scan.find((item) => item.type === type)!,
      detectAll: async () => ({ items: scan }),
    },
  });
});
afterEach(async () => {
  await engine.stop();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows can hold the WAL a moment longer.
  }
});

const api = (path: string, init: RequestInit = {}) =>
  fetch(`${engine.url}/api/v1${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${engine.token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });

describe('FR-PRV-008 CLI providers through the real engine (X1)', () => {
  it('answers the terminal scan', async () => {
    const response = await api('/providers/detect/clis');
    expect(response.status).toBe(200);
    const items = ((await response.json()) as { items: CliDetection[] }).items;
    expect(items.map((item) => item.type)).toEqual(['claude_code', 'codex_cli', 'gemini_cli']);
    // Only the injected scan reports this version: the engine never ran a real CLI here.
    expect(items[0]?.version).toBe('0.0.0-fake-scan');
  });

  it('adds Claude Code with no key, checks it CONNECTED, and lists its models', async () => {
    const created = (await (
      await api('/providers', { method: 'POST', body: JSON.stringify({ type: 'claude_code', name: 'Claude Code', concurrency: 1 }) })
    ).json()) as { id: string; cliPermission: string; keySet: boolean };
    expect(created).toMatchObject({ cliPermission: 'edit_files', keySet: false });

    const check = (await (await api(`/providers/${created.id}/check`, { method: 'POST' })).json()) as {
      status: string;
      message?: string;
    };
    expect(check).toMatchObject({ status: 'CONNECTED', message: 'v0.0.0-fake-scan · claude.ai' });

    await api(`/providers/${created.id}/refresh-models`, { method: 'POST' });
    const models = (await (await api(`/models?providerId=${created.id}`)).json()) as { items: { modelId: string }[] };
    expect(models.items.map((model) => model.modelId).sort()).toEqual(['default', 'haiku', 'opus', 'sonnet']);
  });

  it('refuses a key on a CLI provider', async () => {
    const response = await api('/providers', {
      method: 'POST',
      body: JSON.stringify({ type: 'claude_code', name: 'C', apiKey: 'sk-x' }),
    });
    expect(response.status).toBe(400);
  });
});
