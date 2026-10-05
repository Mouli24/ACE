import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ApiErrorSchema, SettingsSchema } from '@ace/contracts';
import { afterAll, describe, expect, it } from 'vitest';

import { startRound5Engine } from './round5-harness.js';

/**
 * TC-SYS-006 (FR-SYS-005): a setting changed through the API survives an engine restart on the same
 * data dir, and `telemetryEnabled` is fixed false in v1 — turning it on is a 400, not a silent
 * no-op (round 5 §2.7, NFR-PRIV-01, D235).
 */

const dir = mkdtempSync(join(tmpdir(), 'ace-r5-settings-'));

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows can still hold the SQLite WAL handle for a moment; the OS reclaims temp itself.
  }
});

describe('TC-SYS-006 settings persist across a restart', () => {
  it('concurrency 5 set before a stop is 5 after a start on the same data dir', async () => {
    const first = await startRound5Engine({ dataDir: dir });
    try {
      const patched = SettingsSchema.parse(
        await first.ok('/settings', {
          method: 'PATCH',
          body: JSON.stringify({ concurrency: 5 }),
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      expect(patched.concurrency).toBe(5);
    } finally {
      await first.stop();
    }

    const second = await startRound5Engine({ dataDir: dir });
    try {
      const settings = SettingsSchema.parse(await second.get('/settings'));
      expect(settings.concurrency).toBe(5);
      expect(settings.dataDir).toBe(dir);
      expect(settings.telemetryEnabled).toBe(false);

      const refused = await second.api('/settings', {
        method: 'PATCH',
        body: JSON.stringify({ telemetryEnabled: true }),
        headers: { 'Content-Type': 'application/json' },
      });
      expect(refused.status).toBe(400);
      expect(ApiErrorSchema.parse(await refused.json()).error.code).toBe('validation_failed');
      expect(SettingsSchema.parse(await second.get('/settings')).telemetryEnabled).toBe(false);
    } finally {
      await second.stop();
    }
  }, 60_000);
});
