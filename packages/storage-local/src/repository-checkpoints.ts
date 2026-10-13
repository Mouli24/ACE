import {
  CheckpointSchema,
  type Checkpoint,
  type CheckpointKind,
  type CheckpointStatus,
  type Id,
} from '@ace/contracts';
import type { CheckpointRepository, Scope, StoredCheckpoint } from '@ace/engine';
import { and, asc, desc, eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import type * as schema from './schema.js';
import { checkpoints } from './schema.js';
import { toJsonColumn } from './secret-guard.js';

type Db = BetterSQLite3Database<typeof schema>;
type CheckpointRow = typeof checkpoints.$inferSelect;

/*
 * Checkpoints (D300): paths and counts only — the file contents live in the private git store
 * under the data dir (design §7). The JSON columns go through `toJsonColumn` like every other, so
 * the secret guard still sees them.
 */

function toStored(row: CheckpointRow): StoredCheckpoint {
  const checkpoint: Checkpoint = CheckpointSchema.parse({
    id: row.id,
    projectId: row.projectId,
    kind: row.kind as CheckpointKind,
    ...(row.threadId === null ? {} : { threadId: row.threadId }),
    ...(row.messageId === null ? {} : { messageId: row.messageId }),
    ...(row.runId === null ? {} : { runId: row.runId }),
    ...(row.nodeId === null ? {} : { nodeId: row.nodeId }),
    status: row.status as CheckpointStatus,
    files: JSON.parse(row.filesJson),
    skipped: JSON.parse(row.skippedJson),
    ...(row.error === null ? {} : { error: row.error }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
  return {
    checkpoint,
    ...(row.beforeRef === null ? {} : { beforeRef: row.beforeRef }),
    ...(row.afterRef === null ? {} : { afterRef: row.afterRef }),
  };
}

export function createCheckpointRepository(db: Db): CheckpointRepository {
  const where = (scope: Scope, id: Id) =>
    and(eq(checkpoints.workspaceId, scope.workspaceId), eq(checkpoints.id, id));
  const read = (scope: Scope, id: Id): StoredCheckpoint | null => {
    const row = db.select().from(checkpoints).where(where(scope, id)).get();
    return row === undefined ? null : toStored(row);
  };

  return {
    insert: async (scope, stored) => {
      const { checkpoint: cp } = stored;
      const at = `checkpoint(${cp.id})`;
      db.insert(checkpoints)
        .values({
          id: cp.id,
          workspaceId: scope.workspaceId,
          projectId: cp.projectId,
          kind: cp.kind,
          threadId: cp.threadId ?? null,
          messageId: cp.messageId ?? null,
          runId: cp.runId ?? null,
          nodeId: cp.nodeId ?? null,
          status: cp.status,
          filesJson: toJsonColumn(cp.files, `${at}.files`),
          skippedJson: toJsonColumn(cp.skipped, `${at}.skipped`),
          beforeRef: stored.beforeRef ?? null,
          afterRef: stored.afterRef ?? null,
          error: cp.error ?? null,
          createdAt: cp.createdAt,
          updatedAt: cp.updatedAt,
        })
        .run();
      return stored;
    },

    get: async (scope, id) => read(scope, id),

    listByProject: async (scope, projectId) =>
      db
        .select()
        .from(checkpoints)
        .where(
          and(eq(checkpoints.workspaceId, scope.workspaceId), eq(checkpoints.projectId, projectId)),
        )
        .orderBy(desc(checkpoints.createdAt), desc(checkpoints.id))
        .all()
        .map(toStored),

    listByStatus: async (scope, status) =>
      db
        .select()
        .from(checkpoints)
        .where(and(eq(checkpoints.workspaceId, scope.workspaceId), eq(checkpoints.status, status)))
        .orderBy(asc(checkpoints.createdAt), asc(checkpoints.id))
        .all()
        .map(toStored),

    update: async (scope, id, patch) => {
      const at = `checkpoint(${id})`;
      const result = db
        .update(checkpoints)
        .set({
          ...(patch.status === undefined ? {} : { status: patch.status }),
          ...(patch.files === undefined
            ? {}
            : { filesJson: toJsonColumn(patch.files, `${at}.files`) }),
          ...(patch.skipped === undefined
            ? {}
            : { skippedJson: toJsonColumn(patch.skipped, `${at}.skipped`) }),
          ...(patch.error === undefined ? {} : { error: patch.error }),
          ...(patch.afterRef === undefined ? {} : { afterRef: patch.afterRef }),
          updatedAt: patch.updatedAt,
        })
        .where(where(scope, id))
        .run();
      return result.changes === 0 ? null : read(scope, id);
    },

    delete: async (scope, id) => db.delete(checkpoints).where(where(scope, id)).run().changes > 0,
  };
}
