import {
  API_BASE_PATH,
  BACKUP_CONTENT_TYPE,
  BACKUP_UPLOAD_FIELD,
  BackupImportResponseSchema,
  type Run,
} from '@ace/contracts';
import type { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { errorCode, routeApp, send } from '../../__tests__/route-app.js';
import { LOCAL_SCOPE, type BackupStore } from '../../ports/index.js';
import { createBackupService, type BackupService } from '../index.js';
import { backupStamp, createBackupRoutes } from '../routes.js';

/**
 * The backup routes of round 5 §2.7 / §2.9 (FR-SYS-012, TC-SYS-014, F12): the export as an
 * `application/zip` attachment named by its UTC time, the import from the multipart field `file`,
 * a foreign zip and a missing file 400, an active run 409 (the service's), and 501 without the
 * service (D121).
 */

const ZIP = new Uint8Array([0x50, 0x4b, 0x05, 0x06, 1, 2, 3]);
const RESTORED = { projects: 2, runs: 3, artifacts: 4 };

class BackupFormatError extends Error {
  override readonly name = 'BackupFormatError';
}

/** The real backup service over a scripted store and a run list. */
function harness(options: { active?: Run[]; importError?: Error } = {}) {
  const imported: Uint8Array[] = [];
  const store: BackupStore = {
    exportZip: async () => ZIP,
    importZip: async (bytes) => {
      if (options.importError !== undefined) throw options.importError;
      imported.push(bytes);
      return RESTORED;
    },
    writePreImportBackup: async () => '/tmp/pre-import.zip',
  };
  const service: BackupService = createBackupService({
    store,
    repository: { runs: { listActive: async () => options.active ?? [] } } as never,
    scope: LOCAL_SCOPE,
  });
  const app = routeApp(
    createBackupRoutes(service, { now: () => new Date('2026-10-05T06:10:42.123Z') }),
  );
  return { app, imported };
}

async function importForm(app: Hono, form: FormData): Promise<Response> {
  return await app.request(`http://127.0.0.1:4747${API_BASE_PATH}/backup/import`, {
    method: 'POST',
    body: form,
  });
}

const zipForm = (bytes: Uint8Array = ZIP): FormData => {
  const form = new FormData();
  form.append(BACKUP_UPLOAD_FIELD, new File([bytes], 'backup.zip', { type: BACKUP_CONTENT_TYPE }));
  return form;
};

describe('FR-SYS-012 POST /backup/export', () => {
  it('streams the zip as an attachment named ace-backup-<UTC stamp>.zip', async () => {
    const { app } = harness();

    const response = await send(app, 'POST', '/backup/export');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(BACKUP_CONTENT_TYPE);
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="ace-backup-20261005T061042Z.zip"',
    );
    expect(response.headers.get('content-length')).toBe(String(ZIP.byteLength));
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(ZIP);
  });

  it('backupStamp is the UTC time, basic ISO, to the second', () => {
    expect(backupStamp(new Date('2026-01-02T03:04:05.999Z'))).toBe('20260102T030405Z');
  });
});

describe('FR-SYS-012 POST /backup/import', () => {
  it('restores the zip from the multipart field and answers { restored }', async () => {
    const { app, imported } = harness();

    const response = await importForm(app, zipForm());

    expect(response.status).toBe(200);
    expect(BackupImportResponseSchema.parse(await response.json())).toEqual({ restored: RESTORED });
    expect(imported).toEqual([ZIP]);
  });

  it('a form without the file, or a body that is no form, is 400', async () => {
    const { app, imported } = harness();

    const empty = await importForm(app, new FormData());
    expect(empty.status).toBe(400);
    expect(await errorCode(empty)).toBe('validation_failed');

    const wrongField = new FormData();
    wrongField.append('zip', new File([ZIP], 'backup.zip'));
    expect((await importForm(app, wrongField)).status).toBe(400);

    expect((await send(app, 'POST', '/backup/import', { file: 'nope' })).status).toBe(400);
    expect(imported).toEqual([]);
  });

  it('a zip that is not an ACE backup is 400 with the store reason', async () => {
    const { app } = harness({
      importError: new BackupFormatError('The zip has no backup.json: it is not an ACE backup.'),
    });

    const response = await importForm(app, zipForm());

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('validation_failed');
    expect(body.error.message).toBe('The zip has no backup.json: it is not an ACE backup.');
  });

  it('an active run is 409 invalid_run_state, naming the run, before anything is restored', async () => {
    const { app, imported } = harness({ active: [{ id: '01JBXQ8Z9KQ4R7N2VWXYZ0RVN1' } as Run] });

    const response = await importForm(app, zipForm());

    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string; details: unknown } };
    expect(body.error.code).toBe('invalid_run_state');
    expect(body.error.details).toEqual({ runIds: ['01JBXQ8Z9KQ4R7N2VWXYZ0RVN1'] });
    expect(imported).toEqual([]);
  });

  it('any other failure is the 500 envelope, never its message', async () => {
    const { app } = harness({ importError: new Error('disk full at C:\\Users\\someone') });

    const response = await importForm(app, zipForm());

    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('someone');
  });
});

describe('D121 a backup route without the service answers 501', () => {
  it('export and import alike', async () => {
    const app = routeApp(createBackupRoutes(undefined));
    for (const response of [
      await send(app, 'POST', '/backup/export'),
      await importForm(app, zipForm()),
    ]) {
      expect(response.status).toBe(501);
      expect(await errorCode(response)).toBe('not_implemented');
    }
  });
});
