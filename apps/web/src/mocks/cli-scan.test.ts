import { CliDetectResponseSchema } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { MOCK_CLI_SCAN } from './cli-scan';
import { MockDb } from './db';

describe('X1 the mock engine’s terminal scan and CLI providers', () => {
  it('serves a scan the contract accepts: one signed in, one signed out, one missing', () => {
    expect(CliDetectResponseSchema.parse(MOCK_CLI_SCAN).items.map((item) => [item.type, item.installed, item.login])).toEqual([
      ['claude_code', true, 'logged_in'],
      ['codex_cli', true, 'logged_out'],
      ['gemini_cli', false, 'unknown'],
    ]);
  });

  it('gives a CLI provider the default permission, and a patch changes it', () => {
    const db = new MockDb();
    const created = db.createProvider({ type: 'claude_code', name: 'Claude Code', concurrency: 1 });
    expect(created.cliPermission).toBe('edit_files');
    expect(db.updateProvider(created.id, { cliPermission: 'full_auto' })?.cliPermission).toBe('full_auto');
    expect(db.createProvider({ type: 'mock', name: 'Mock' })).not.toHaveProperty('cliPermission');
  });
});
