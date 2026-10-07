import type { Bundle, Id, Skill } from '@ace/contracts';

import type { Scope } from './scope.js';

/*
 * ACE parity P1 ports (docs/ACE_FEATURE_PARITY.md §3.5, D272, D273): where installed skills and
 * imported bundles are kept. Interfaces only — `packages/storage-local` implements them. The rules
 * (a built-in is read-only, a name is unique, a bundle connects nothing) are the skill service's;
 * a repository only stores what it is handed.
 */

export interface SkillRepository {
  create(scope: Scope, skill: Skill): Promise<Skill>;
  get(scope: Scope, id: Id): Promise<Skill | null>;
  /**
   * The skill with this name, compared case-insensitively — the same comparison the store's unique
   * name index makes, so "is this name taken" and "would this insert be refused" agree.
   */
  getByName(scope: Scope, name: string): Promise<Skill | null>;
  /** Built-in skills first, then every other skill by name (case-insensitively), then by id. */
  list(scope: Scope): Promise<Skill[]>;
  /** Replaces the stored skill with this one (same id); throws if it does not exist. */
  save(scope: Scope, skill: Skill): Promise<Skill>;
  /** `false` if it was not there. */
  delete(scope: Scope, id: Id): Promise<boolean>;
}

export interface BundleRepository {
  create(scope: Scope, bundle: Bundle): Promise<Bundle>;
  get(scope: Scope, id: Id): Promise<Bundle | null>;
  /** Oldest first — the order the user imported them. */
  list(scope: Scope): Promise<Bundle[]>;
  /** Removes the bundle row only; its skills are the service's to remove. `false` if absent. */
  delete(scope: Scope, id: Id): Promise<boolean>;
}
