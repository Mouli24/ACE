import type { Bundle, Id, Skill } from '@ace/contracts';

import { FakeRepository } from '../../__tests__/fake-repository.js';
import type { BundleRepository, Repository, SkillRepository } from '../../ports/index.js';
import { createSkillService, type SkillService } from '../service.js';

/**
 * In-memory skill and bundle repositories for the engine's skill tests, the way the task tests
 * attach theirs to the `FakeRepository`. They keep the store's rules a test can observe: names are
 * unique case-insensitively (the SQLite index), built-ins list first, and `save` refuses a row that
 * is not stored. Rows are cloned in and out, so a test cannot change a stored skill by accident.
 */

const clone = <T>(value: T): T => structuredClone(value);

export class InMemorySkillRepos {
  readonly skillRows = new Map<Id, Skill>();
  readonly bundleRows = new Map<Id, Bundle>();
  /** When set, the next skill create throws — to prove an import rolls back whole. */
  failNextSkillCreate = false;

  readonly skills: SkillRepository = {
    create: async (_scope, skill) => {
      if (this.failNextSkillCreate) {
        this.failNextSkillCreate = false;
        throw new Error('the store refused the skill');
      }
      const lower = skill.name.toLowerCase();
      if ([...this.skillRows.values()].some((row) => row.name.toLowerCase() === lower)) {
        throw new Error('UNIQUE constraint failed: skills.workspace_id, lower(name)');
      }
      this.skillRows.set(skill.id, clone(skill));
      return clone(skill);
    },
    get: async (_scope, id) => {
      const row = this.skillRows.get(id);
      return row === undefined ? null : clone(row);
    },
    getByName: async (_scope, name) => {
      const lower = name.toLowerCase();
      const row = [...this.skillRows.values()].find((skill) => skill.name.toLowerCase() === lower);
      return row === undefined ? null : clone(row);
    },
    list: async () =>
      [...this.skillRows.values()]
        .sort(
          (a, b) =>
            Number(b.source === 'builtin') - Number(a.source === 'builtin') ||
            a.name.toLowerCase().localeCompare(b.name.toLowerCase()) ||
            a.id.localeCompare(b.id),
        )
        .map(clone),
    save: async (_scope, skill) => {
      if (!this.skillRows.has(skill.id)) throw new Error(`Skill ${skill.id} is not stored`);
      this.skillRows.set(skill.id, clone(skill));
      return clone(skill);
    },
    delete: async (_scope, id) => this.skillRows.delete(id),
  };

  readonly bundles: BundleRepository = {
    create: async (_scope, bundle) => {
      this.bundleRows.set(bundle.id, clone(bundle));
      return clone(bundle);
    },
    get: async (_scope, id) => {
      const row = this.bundleRows.get(id);
      return row === undefined ? null : clone(row);
    },
    list: async () =>
      [...this.bundleRows.values()]
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
        .map(clone),
    delete: async (_scope, id) => this.bundleRows.delete(id),
  };

  /** Everything stored, for a rollback test to compare before and after. */
  snapshot(): { skills: Skill[]; bundles: Bundle[] } {
    return {
      skills: [...this.skillRows.values()].map(clone),
      bundles: [...this.bundleRows.values()].map(clone),
    };
  }

  restore(state: { skills: Skill[]; bundles: Bundle[] }): void {
    this.skillRows.clear();
    for (const skill of state.skills) this.skillRows.set(skill.id, clone(skill));
    this.bundleRows.clear();
    for (const bundle of state.bundles) this.bundleRows.set(bundle.id, clone(bundle));
  }
}

/**
 * Attaches the skill repositories to a repository. The `FakeRepository` rolls back only its own
 * maps, so `transaction` is wrapped to put these rows back too when the body throws — what the
 * SQLite adapter's one transaction does for both tables.
 */
export function withSkills<R extends Repository>(repository: R, repos = new InMemorySkillRepos()) {
  const transaction = repository.transaction.bind(repository);
  let depth = 0;
  Object.assign(repository, {
    skills: repos.skills,
    bundles: repos.bundles,
    transaction: async <T>(fn: (tx: Repository) => Promise<T>): Promise<T> => {
      const saved = depth === 0 ? repos.snapshot() : undefined;
      depth += 1;
      try {
        return await transaction(fn);
      } catch (error) {
        if (saved !== undefined) repos.restore(saved);
        throw error;
      } finally {
        depth -= 1;
      }
    },
  });
  return { repository, repos };
}

export const SKILL_TEST_NOW = '2026-10-07T10:00:00.000Z';

export interface SkillHarness {
  repository: FakeRepository;
  repos: InMemorySkillRepos;
  service: SkillService;
  /** Moves the service's clock on, so an edit's `updatedAt` differs from its `createdAt`. */
  tick(at: string): void;
}

export function createSkillHarness(): SkillHarness {
  const { repository, repos } = withSkills(new FakeRepository());
  let at = SKILL_TEST_NOW;
  let counter = 0;
  const service = createSkillService({
    repository,
    scope: { workspaceId: 'local' },
    now: () => at,
    // Deterministic, ordered, valid ULIDs: a fixed time part and a counter.
    nextId: () => `01K6TEST${String((counter += 1)).padStart(18, '0')}`,
  });
  return {
    repository,
    repos,
    service,
    tick: (next) => {
      at = next;
    },
  };
}
