import {
  ProjectNoteSchema,
  ResponsibilitySchema,
  SuggestionSchema,
  type Id,
  type ProjectNote,
  type Responsibility,
  type Suggestion,
  type SuggestionStatus,
} from '@ace/contracts';
import type {
  ProjectNoteRepository,
  ResponsibilityRepository,
  Scope,
  SuggestionRepository,
} from '@ace/engine';
import { and, asc, desc, eq, type SQL } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import type * as schema from './schema.js';
import { projectNotes, responsibilities, suggestions } from './schema.js';
import { assertNoSecrets, toJsonColumn } from './secret-guard.js';

type Db = BetterSQLite3Database<typeof schema>;

/**
 * The ACE parity P2 repositories (D280, D281): responsibilities, the suggestions their scans
 * produce, and a project's team notes. Rows are parsed through their contracts on the way out and
 * walked by the secret guard on the way in (BR-07). Each goes with its project; a suggestion goes
 * with its responsibility. A suggestion's fingerprint is unique per project, so the store itself
 * refuses to suggest the same thing twice.
 */

type ResponsibilityRow = typeof responsibilities.$inferSelect;
type SuggestionRow = typeof suggestions.$inferSelect;
type NoteRow = typeof projectNotes.$inferSelect;

function assertSaved(changes: number, what: string, id: Id): void {
  if (changes === 0) throw new Error(`${what} ${id} is not stored, so it cannot be saved`);
}

/* -------------------------------------------------------------------------- */
/* Responsibilities                                                            */
/* -------------------------------------------------------------------------- */

function toResponsibility(row: ResponsibilityRow): Responsibility {
  return ResponsibilitySchema.parse({
    id: row.id,
    projectId: row.projectId,
    kind: row.kind,
    title: row.title,
    why: row.why,
    goodWork: row.goodWork,
    ...(row.query === null ? {} : { query: row.query }),
    watch: row.watch,
    watchIntervalMinutes: row.watchIntervalMinutes,
    paused: row.paused,
    ...(row.lastScanAt === null ? {} : { lastScanAt: row.lastScanAt }),
    ...(row.lastScanStatus === null ? {} : { lastScanStatus: row.lastScanStatus }),
    ...(row.lastScanMessage === null ? {} : { lastScanMessage: row.lastScanMessage }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function responsibilityColumns(responsibility: Responsibility) {
  assertNoSecrets(responsibility, `responsibility(${responsibility.id})`);
  return {
    projectId: responsibility.projectId,
    kind: responsibility.kind,
    title: responsibility.title,
    why: responsibility.why,
    goodWork: responsibility.goodWork,
    query: responsibility.query ?? null,
    watch: responsibility.watch,
    watchIntervalMinutes: responsibility.watchIntervalMinutes,
    paused: responsibility.paused,
    lastScanAt: responsibility.lastScanAt ?? null,
    lastScanStatus: responsibility.lastScanStatus ?? null,
    lastScanMessage: responsibility.lastScanMessage ?? null,
    createdAt: responsibility.createdAt,
    updatedAt: responsibility.updatedAt,
  };
}

export function createResponsibilityRepository(db: Db): ResponsibilityRepository {
  const inScope = (scope: Scope, ...conditions: (SQL | undefined)[]) =>
    and(eq(responsibilities.workspaceId, scope.workspaceId), ...conditions);

  return {
    create: async (scope, responsibility) => {
      db.insert(responsibilities)
        .values({
          id: responsibility.id,
          workspaceId: scope.workspaceId,
          ...responsibilityColumns(responsibility),
        })
        .run();
      return responsibility;
    },

    get: async (scope, id) => {
      const row = db
        .select()
        .from(responsibilities)
        .where(inScope(scope, eq(responsibilities.id, id)))
        .get();
      return row === undefined ? null : toResponsibility(row);
    },

    /** Oldest first (ids are monotonic). */
    listByProject: async (scope, projectId) =>
      db
        .select()
        .from(responsibilities)
        .where(inScope(scope, eq(responsibilities.projectId, projectId)))
        .orderBy(asc(responsibilities.id))
        .all()
        .map(toResponsibility),

    listWatched: async (scope) =>
      db
        .select()
        .from(responsibilities)
        .where(inScope(scope, eq(responsibilities.watch, true), eq(responsibilities.paused, false)))
        .orderBy(asc(responsibilities.id))
        .all()
        .map(toResponsibility),

    save: async (scope, responsibility) => {
      const { changes } = db
        .update(responsibilities)
        .set(responsibilityColumns(responsibility))
        .where(inScope(scope, eq(responsibilities.id, responsibility.id)))
        .run();
      assertSaved(changes, 'Responsibility', responsibility.id);
      return responsibility;
    },

    /** Its suggestions go with it (foreign key cascade). */
    delete: async (scope, id) =>
      db
        .delete(responsibilities)
        .where(inScope(scope, eq(responsibilities.id, id)))
        .run().changes > 0,
  };
}

/* -------------------------------------------------------------------------- */
/* Suggestions                                                                 */
/* -------------------------------------------------------------------------- */

function toSuggestion(row: SuggestionRow): Suggestion {
  return SuggestionSchema.parse({
    id: row.id,
    projectId: row.projectId,
    responsibilityId: row.responsibilityId,
    title: row.title,
    reason: row.reason,
    evidence: JSON.parse(row.evidence),
    proposedAction: row.proposedAction,
    completionCriteria: row.completionCriteria,
    status: row.status,
    ...(row.taskId === null ? {} : { taskId: row.taskId }),
    fingerprint: row.fingerprint,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function suggestionColumns(suggestion: Suggestion) {
  assertNoSecrets(suggestion, `suggestion(${suggestion.id})`);
  return {
    projectId: suggestion.projectId,
    responsibilityId: suggestion.responsibilityId,
    title: suggestion.title,
    reason: suggestion.reason,
    evidence: toJsonColumn(suggestion.evidence, `suggestion(${suggestion.id}).evidence`),
    proposedAction: suggestion.proposedAction,
    completionCriteria: suggestion.completionCriteria,
    status: suggestion.status,
    taskId: suggestion.taskId ?? null,
    fingerprint: suggestion.fingerprint,
    createdAt: suggestion.createdAt,
    updatedAt: suggestion.updatedAt,
  };
}

export function createSuggestionRepository(db: Db): SuggestionRepository {
  const inScope = (scope: Scope, ...conditions: (SQL | undefined)[]) =>
    and(eq(suggestions.workspaceId, scope.workspaceId), ...conditions);

  return {
    create: async (scope, suggestion) => {
      db.insert(suggestions)
        .values({
          id: suggestion.id,
          workspaceId: scope.workspaceId,
          ...suggestionColumns(suggestion),
        })
        .run();
      return suggestion;
    },

    get: async (scope, id) => {
      const row = db
        .select()
        .from(suggestions)
        .where(inScope(scope, eq(suggestions.id, id)))
        .get();
      return row === undefined ? null : toSuggestion(row);
    },

    /** Newest first. */
    listByProject: async (scope, projectId, status?: SuggestionStatus) =>
      db
        .select()
        .from(suggestions)
        .where(
          inScope(
            scope,
            eq(suggestions.projectId, projectId),
            status === undefined ? undefined : eq(suggestions.status, status),
          ),
        )
        .orderBy(desc(suggestions.id))
        .all()
        .map(toSuggestion),

    getByFingerprint: async (scope, projectId, fingerprint) => {
      const row = db
        .select()
        .from(suggestions)
        .where(
          inScope(
            scope,
            eq(suggestions.projectId, projectId),
            eq(suggestions.fingerprint, fingerprint),
          ),
        )
        .get();
      return row === undefined ? null : toSuggestion(row);
    },

    save: async (scope, suggestion) => {
      const { changes } = db
        .update(suggestions)
        .set(suggestionColumns(suggestion))
        .where(inScope(scope, eq(suggestions.id, suggestion.id)))
        .run();
      assertSaved(changes, 'Suggestion', suggestion.id);
      return suggestion;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Team notes                                                                  */
/* -------------------------------------------------------------------------- */

function toNote(row: NoteRow): ProjectNote {
  return ProjectNoteSchema.parse({
    id: row.id,
    projectId: row.projectId,
    text: row.text,
    status: row.status,
    source: row.source,
    ...(row.refId === null ? {} : { refId: row.refId }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function noteColumns(note: ProjectNote) {
  assertNoSecrets(note, `projectNote(${note.id})`);
  return {
    projectId: note.projectId,
    text: note.text,
    status: note.status,
    source: note.source,
    refId: note.refId ?? null,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
  };
}

export function createProjectNoteRepository(db: Db): ProjectNoteRepository {
  const inScope = (scope: Scope, ...conditions: (SQL | undefined)[]) =>
    and(eq(projectNotes.workspaceId, scope.workspaceId), ...conditions);

  return {
    create: async (scope, note) => {
      db.insert(projectNotes)
        .values({ id: note.id, workspaceId: scope.workspaceId, ...noteColumns(note) })
        .run();
      return note;
    },

    get: async (scope, id) => {
      const row = db
        .select()
        .from(projectNotes)
        .where(inScope(scope, eq(projectNotes.id, id)))
        .get();
      return row === undefined ? null : toNote(row);
    },

    /** Oldest first. */
    listByProject: async (scope, projectId) =>
      db
        .select()
        .from(projectNotes)
        .where(inScope(scope, eq(projectNotes.projectId, projectId)))
        .orderBy(asc(projectNotes.id))
        .all()
        .map(toNote),

    save: async (scope, note) => {
      const { changes } = db
        .update(projectNotes)
        .set(noteColumns(note))
        .where(inScope(scope, eq(projectNotes.id, note.id)))
        .run();
      assertSaved(changes, 'Note', note.id);
      return note;
    },

    delete: async (scope, id) =>
      db
        .delete(projectNotes)
        .where(inScope(scope, eq(projectNotes.id, id)))
        .run().changes > 0,
  };
}
