import { BACKUP_CONTENT_TYPE, BACKUP_UPLOAD_FIELD } from '@ace/contracts';
import { Hono } from 'hono';

import { HttpError, notImplemented } from '../gateway/errors.js';
import type { BackupService } from './index.js';

/**
 * The backup routes (round 5 §2.7, §2.9, FR-SYS-012, TC-SYS-014, F12):
 *
 * - `POST /backup/export` — the zip as an `application/zip` attachment named by its UTC time,
 *   `ace-backup-<YYYYMMDDTHHMMSSZ>.zip`. It never holds a key: keys live in the keychain.
 * - `POST /backup/import` — the zip from the multipart field `file`, as `POST /artifacts` reads it →
 *   `{ restored }`. The service refuses while a run is active (409 `invalid_run_state`); a zip that is
 *   not an ACE backup (the store's `BackupFormatError`, matched by name as the port documents) and a
 *   form without the file are 400 `validation_failed`.
 *
 * `service` may be `undefined`: the routes then answer 501 `not_implemented` (D121).
 */

export type BackupRouter = Hono<{ Variables: { requestId: string } }>;

/** `2026-10-05T06:10:00.123Z` → `20261005T061000Z`: sortable, and safe in any file system. */
export function backupStamp(at: Date): string {
  return `${at.toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`;
}

/** A copy of the bytes as a standalone `ArrayBuffer`, which is what `c.body` accepts. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

const invalid = (message: string): HttpError =>
  new HttpError('invalid_config', 'validation_failed', message);

export function createBackupRoutes(
  service: BackupService | undefined,
  options: { now?: () => Date } = {},
): BackupRouter {
  const router: BackupRouter = new Hono<{ Variables: { requestId: string } }>();
  const now = options.now ?? (() => new Date());

  const backup = (): BackupService => {
    if (service === undefined) throw notImplemented('backup');
    return service;
  };

  router.post('/backup/export', async (c) => {
    const bytes = await backup().exportZip();
    return c.body(toArrayBuffer(bytes), 200, {
      'Content-Type': BACKUP_CONTENT_TYPE,
      'Content-Disposition': `attachment; filename="ace-backup-${backupStamp(now())}.zip"`,
      'Content-Length': String(bytes.byteLength),
    });
  });

  router.post('/backup/import', async (c) => {
    const service = backup();
    const body = await c.req.parseBody();
    const file = body[BACKUP_UPLOAD_FIELD];
    if (!(file instanceof File)) {
      throw invalid(
        `A multipart form field "${BACKUP_UPLOAD_FIELD}" carrying the backup zip is required.`,
      );
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    try {
      return c.json(await service.importZip(bytes));
    } catch (error) {
      // The store's reason is already a sentence a user can act on, and names nothing secret.
      if (error instanceof Error && error.name === 'BackupFormatError') {
        throw invalid(error.message);
      }
      throw error;
    }
  });

  return router;
}
