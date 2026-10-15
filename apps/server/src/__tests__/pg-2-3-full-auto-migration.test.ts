import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CliDetection } from '@ace/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startEngine, type RunningEngine } from '../server.js';

/**
 * PG-2.3 No silent Full auto (docs/team-prompts/product-gaps-fix-prompt.md, X6).
 *
 * Phase 0 red test: a startup migration moves every provider still on `full_auto` to `edit_files`
 * (the contract keeps the value only so old rows parse). A provider saved on `full_auto` by an
 * earlier engine is read back on `edit_files` after the engine restarts on the same data dir.
 */

const scan: CliDetection[] = [
  {
    type: 'claude_code',
    installed: true,
    version: '0.0.0-fake-scan',
    login: 'logged_in',
    loginDetail: 'claude.ai',
    installHint: 'npm install -g @anthropic-ai/claude-code',
    loginHint: 'claude auth login',
  },
  {
    type: 'codex_cli',
    installed: false,
    login: 'unknown',
    installHint: 'npm install -g @openai/codex',
    loginHint: 'codex login',
  },
  {
    type: 'gemini_cli',
    installed: false,
    login: 'unknown',
    installHint: 'npm install -g @google/gemini-cli',
    loginHint: 'gemini',
  },
];

let dir: string;
let engine: RunningEngine | undefined;

const start = () =>
  startEngine({
    dataDir: dir,
    port: 0,
    env: {},
    cliDetector: {
      detect: async (type) => scan.find((item) => item.type === type)!,
      detectAll: async () => ({ items: scan }),
    },
    // No CLI is ever spawned: nothing resolves.
    cliResolve: () => undefined,
  });

const api = (path: string, init: RequestInit = {}) =>
  fetch(`${engine!.url}/api/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${engine!.token}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ace-pg23-'));
});

afterEach(async () => {
  await engine?.stop();
  engine = undefined;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows can hold the WAL a moment longer.
  }
});

describe('PG-2.3 a startup migration moves full_auto providers to edit_files', () => {
  it.fails(
    'a provider saved on full_auto reads back on edit_files after a restart',
    async () => {
      engine = await start();
      const created = (await (
        await api('/providers', {
          method: 'POST',
          body: JSON.stringify({
            type: 'claude_code',
            name: 'Claude Code',
            concurrency: 1,
            cliPermission: 'full_auto',
          }),
        })
      ).json()) as { id: string; cliPermission: string };
      // Setup, true today: the row really is on full_auto before the restart.
      expect(created.cliPermission).toBe('full_auto');
      await engine.stop();

      engine = await start();
      const { items } = (await (await api('/providers')).json()) as {
        items: { id: string; cliPermission?: string }[];
      };

      expect(items.find((provider) => provider.id === created.id)?.cliPermission).toBe(
        'edit_files',
      );
    },
    30_000,
  );
});
