import type { BackupImportResponse, Run } from '@ace/contracts';

import { HttpError } from '../gateway/errors.js';
import type { BackupStore, Repository, Scope } from '../ports/index.js';

/**
 * The backup service (round 5 §2.7, FR-SYS-012, F12). Export is the store's zip; import refuses
 * while a run is active, because the restore replaces the tables a run is writing to. The store's
 * `importZip` takes the pre-import backup itself, after validating the incoming file.
 */

export interface BackupService {
  exportZip(): Promise<Uint8Array>;
  importZip(bytes: Uint8Array): Promise<BackupImportResponse>;
}

export interface BackupServiceDeps {
  store: BackupStore;
  repository: Pick<Repository, 'runs'>;
  scope: Scope;
}

export function createBackupService(deps: BackupServiceDeps): BackupService {
  return {
    exportZip: () => deps.store.exportZip(),

    async importZip(bytes) {
      const active: Run[] = await deps.repository.runs.listActive(deps.scope);
      if (active.length > 0) {
        throw new HttpError(
          'workflow',
          'invalid_run_state',
          'A backup cannot be restored while a run is active. Stop or wait for it to finish first.',
          { runIds: active.map((run) => run.id) },
        );
      }
      return { restored: await deps.store.importZip(bytes) };
    },
  };
}
