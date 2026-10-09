import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

/**
 * A scripted `claude` that answers the stream-json `initialize` handshake the way Claude Code
 * 2.1.282 does (D286), so the engine lists models by asking a CLI without a real one ever running.
 */
const FAKE_CLAUDE = `
let buffered = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffered += chunk;
  const line = buffered.split('\\n')[0];
  if (!buffered.includes('\\n')) return;
  const request = JSON.parse(line);
  process.stdout.write(JSON.stringify({
    type: 'control_response',
    response: { subtype: 'success', request_id: request.request_id, response: {
      models: [
        { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)' },
        { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5' },
        { value: 'claude-fable-5-1', displayName: 'Fable 5.1' },
      ],
      unavailable_models: [{ value: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5', description: 'Update Claude Code to use this model', disabled: true }],
    } },
  }) + '\\n');
});
process.stdin.on('end', () => process.exit(0));
`;

let dir: string;
let engine: RunningEngine;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ace-x1-server-'));
  const fakeClaude = join(dir, 'fake-claude.mjs');
  writeFileSync(fakeClaude, FAKE_CLAUDE);
  engine = await startEngine({
    dataDir: dir,
    port: 0,
    env: {},
    cliDetector: {
      detect: async (type) => scan.find((item) => item.type === type)!,
      detectAll: async () => ({ items: scan }),
    },
    // Only Claude Code is "installed"; Codex and Gemini are not, as the scan says.
    cliResolve: (bin) =>
      bin === 'claude' ? { command: process.execPath, prefixArgs: [fakeClaude], path: fakeClaude } : undefined,
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

    // D286: listed as it was added — no Refresh needed — and exactly what the CLI said.
    const models = (await (await api(`/models?providerId=${created.id}`)).json()) as {
      items: { modelId: string; available: boolean; resolvedModelId?: string; unavailableReason?: string }[];
    };
    expect(models.items.map((model) => model.modelId).sort()).toEqual([
      'claude-fable-5-1',
      'claude-sonnet-5-5',
      'default',
      'opus',
    ]);
    expect(models.items.find((model) => model.modelId === 'opus')).toMatchObject({
      available: true,
      resolvedModelId: 'claude-opus-5-5',
    });
    expect(models.items.find((model) => model.modelId === 'claude-sonnet-5-5')).toMatchObject({
      available: false,
      unavailableReason: 'Update Claude Code to use this model',
    });

    const refreshed = (await (await api(`/providers/${created.id}/refresh-models`, { method: 'POST' })).json()) as {
      models: unknown[];
      warning?: string;
    };
    expect(refreshed.models).toHaveLength(4);
    expect(refreshed.warning).toBeUndefined();
  });

  it('D286: a CLI that is not installed lists no models, and the refresh says why', async () => {
    const created = (await (
      await api('/providers', { method: 'POST', body: JSON.stringify({ type: 'codex_cli', name: 'Codex', concurrency: 1 }) })
    ).json()) as { id: string };

    const refreshed = (await (await api(`/providers/${created.id}/refresh-models`, { method: 'POST' })).json()) as {
      models: unknown[];
      warning?: string;
    };
    expect(refreshed.models).toEqual([]);
    expect(refreshed.warning).toMatch(/not installed/);
  });

  it.each([
    ['claude_code', 'CONNECTED'],
    ['codex_cli', 'UNREACHABLE'],
    ['gemini_cli', 'UNREACHABLE'],
  ])('adds %s with no key and the default permission; Test says %s', async (type, status) => {
    const created = (await (
      await api('/providers', { method: 'POST', body: JSON.stringify({ type, name: type, concurrency: 1 }) })
    ).json()) as { id: string; cliPermission: string; keySet: boolean };
    expect(created).toMatchObject({ cliPermission: 'edit_files', keySet: false });
    const check = (await (await api(`/providers/${created.id}/check`, { method: 'POST' })).json()) as { status: string };
    expect(check.status).toBe(status);
  });

  it('refuses a key on a CLI provider', async () => {
    const response = await api('/providers', {
      method: 'POST',
      body: JSON.stringify({ type: 'claude_code', name: 'C', apiKey: 'sk-x' }),
    });
    expect(response.status).toBe(400);
  });
});
