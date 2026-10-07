import type { Id, ProjectNote, Responsibility, Suggestion, SuggestionStatus } from '@ace/contracts';

import type { Scope } from './scope.js';

/*
 * ACE parity P2 ports (D280, D281): where responsibilities, the suggestions their scans produce and
 * a project's team notes are kept. `packages/storage-local` implements them.
 */

export interface ResponsibilityRepository {
  create(scope: Scope, responsibility: Responsibility): Promise<Responsibility>;
  get(scope: Scope, id: Id): Promise<Responsibility | null>;
  /** Oldest first. */
  listByProject(scope: Scope, projectId: Id): Promise<Responsibility[]>;
  /** Every responsibility with watching on and not paused, across projects. */
  listWatched(scope: Scope): Promise<Responsibility[]>;
  save(scope: Scope, responsibility: Responsibility): Promise<Responsibility>;
  /** Removes it and its suggestions that were never accepted. */
  delete(scope: Scope, id: Id): Promise<boolean>;
}

export interface SuggestionRepository {
  create(scope: Scope, suggestion: Suggestion): Promise<Suggestion>;
  get(scope: Scope, id: Id): Promise<Suggestion | null>;
  /** Newest first, optionally of one status. */
  listByProject(scope: Scope, projectId: Id, status?: SuggestionStatus): Promise<Suggestion[]>;
  /** The suggestion of this project with this fingerprint, whatever its status. */
  getByFingerprint(scope: Scope, projectId: Id, fingerprint: string): Promise<Suggestion | null>;
  save(scope: Scope, suggestion: Suggestion): Promise<Suggestion>;
}

export interface ProjectNoteRepository {
  create(scope: Scope, note: ProjectNote): Promise<ProjectNote>;
  get(scope: Scope, id: Id): Promise<ProjectNote | null>;
  /** Oldest first. */
  listByProject(scope: Scope, projectId: Id): Promise<ProjectNote[]>;
  save(scope: Scope, note: ProjectNote): Promise<ProjectNote>;
  delete(scope: Scope, id: Id): Promise<boolean>;
}
