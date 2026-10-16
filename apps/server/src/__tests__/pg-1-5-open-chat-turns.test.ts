import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ChatThreadDetailSchema } from '@ace/contracts';
import { openDatabase } from '@ace/storage-local';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startEngine, type RunningEngine } from '../server.js';

/**
 * PG-1.5 A failed message always shows (docs/team-prompts/product-gaps-fix-prompt.md).
 *
 * A chat turn the last process accepted but never answered — it died or shut down mid-reply —
 * is closed as a failed agent turn when the engine starts again on the same data dir, so the
 * thread reads as ended rather than "typing…" forever. The open turn is written straight into the
 * database between the two starts, as a killed engine would have left it.
 */

const WORKSPACE = 'local';
const THREAD_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0THR9';
const USER_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0MSG9';
const NODE_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0ND99';
const AT = '2026-10-15T10:00:00.000Z';

let dir: string;
let engine: RunningEngine | undefined;

const start = () =>
  startEngine({
    dataDir: dir,
    port: 0,
    env: {},
    cliDetector: {
      detect: async (type) => ({
        type,
        installed: false,
        login: 'unknown',
        installHint: '',
        loginHint: '',
      }),
      detectAll: async () => ({ items: [] }),
    },
    cliResolve: () => undefined,
  });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ace-pg15-'));
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

describe('PG-1.5 open chat turns are marked failed on engine start', () => {
  it('a user turn with no reply reads back with one failed agent turn after a restart', async () => {
    engine = await start();
    await engine.stop();
    engine = undefined;

    const { sqlite } = openDatabase({ path: join(dir, 'ace.sqlite') });
    sqlite
      .prepare(
        `INSERT INTO chat_threads (id, workspace_id, node_id, title, created_at, updated_at)
         VALUES (?, ?, ?, 'left open', ?, ?)`,
      )
      .run(THREAD_ID, WORKSPACE, NODE_ID, AT, AT);
    sqlite
      .prepare(
        `INSERT INTO chat_messages (id, workspace_id, thread_id, role, content, verdicts, at)
         VALUES (?, ?, ?, 'user', '[{"type":"text","text":"still waiting"}]', '[]', ?)`,
      )
      .run(USER_ID, WORKSPACE, THREAD_ID, AT);
    sqlite.close();

    engine = await start();
    const response = await fetch(`${engine.url}/api/v1/chat/threads/${THREAD_ID}`, {
      headers: { Authorization: `Bearer ${engine.token}` },
    });
    expect(response.status).toBe(200);
    const detail = ChatThreadDetailSchema.parse(await response.json());
    const agent = detail.messages.filter((message) => message.role === 'agent');
    expect(agent).toHaveLength(1);
    expect(agent[0]?.error?.code).toBe('crash');
    expect(agent[0]?.error?.retryable).toBe(true);
  });
});
