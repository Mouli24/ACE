import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDatabase, type OpenDatabase } from '../db.js';
import { SqliteRepository } from '../repository.js';

export interface TempDb extends OpenDatabase {
  dir: string;
  repository: SqliteRepository;
  close(): void;
}

/**
 * A fresh SQLite file in its own temp directory, migrated and ready. One per test, so nothing
 * leaks between them and `pnpm test` needs no env var and no fixture database.
 */
export function createTempDb(): TempDb {
  const dir = mkdtempSync(join(tmpdir(), 'ace-test-'));
  const opened = openDatabase({ path: join(dir, 'ace.sqlite') });

  return {
    ...opened,
    dir,
    repository: new SqliteRepository(opened.db, opened.sqlite),
    close() {
      opened.sqlite.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
