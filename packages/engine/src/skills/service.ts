import {
  SKILL_NAME_MAX,
  type Bundle,
  type BundleFile,
  type CreateSkillRequest,
  type Id,
  type Skill,
  type Timestamp,
  type UpdateSkillRequest,
} from '@ace/contracts';

import { HttpError, notFound } from '../gateway/errors.js';
import { newId } from '../ids.js';
import type { BundleRepository, Repository, Scope, SkillRepository } from '../ports/index.js';
import { BUILTIN_SKILLS } from './builtin.js';

/**
 * The skills library (ACE parity P1, D272, D273, FR-SKL-001..003).
 *
 * A skill is installed here and used by an agent only once its `skillIds` names it; this service
 * never enables anything. Built-in skills are read-only (duplicate one to change it). A bundle
 * import installs its skills and records its plugin (MCP server) definitions on the bundle, and
 * connects none of them — connecting a server stays the user's step, through `/mcp-servers`.
 *
 * Every write that reads before it writes — a name check, a version bump, an import that creates
 * several rows — runs in one transaction, so two requests cannot both take the same name and a
 * failed import leaves nothing behind (NFR-REL-02).
 */
export interface SkillService {
  /** Built-in skills first, then the rest by name. */
  list(): Promise<Skill[]>;
  get(id: Id): Promise<Skill>;
  /** A `user` skill at version 1; a taken name (any case) is 409 `name_taken`. */
  create(body: CreateSkillRequest): Promise<Skill>;
  /**
   * The version goes up by one when the name or the instructions change, not for a description.
   * A built-in is 409 `skill_read_only`; a name another skill has is 409 `name_taken`.
   */
  update(id: Id, patch: UpdateSkillRequest): Promise<Skill>;
  /** A built-in is 409 `skill_read_only`. Agents that named it fail pre-flight (`missing_skill`). */
  remove(id: Id): Promise<void>;
  /** A `user` copy named "<name> (copy)" — "(copy 2)" and so on when that is taken. */
  duplicate(id: Id): Promise<Skill>;
  /** Inserts the built-ins an install does not have yet, at engine start; idempotent. */
  ensureBuiltinSkills(): Promise<Skill[]>;

  /** Oldest first. */
  listBundles(): Promise<Bundle[]>;
  /**
   * One `bundle` skill per skill in the file — a taken name gets " (<bundle name>)" — and the
   * bundle with its MCP server definitions, unconnected (D273).
   */
  importBundle(file: BundleFile): Promise<Bundle>;
  /** Removes the bundle and the skills it installed; servers the user connected stay connected. */
  removeBundle(id: Id): Promise<void>;
}

export interface SkillServiceDeps {
  repository: Repository;
  scope: Scope;
  now?: () => Timestamp;
  nextId?: () => Id;
}

interface SkillRepositories {
  skills: SkillRepository;
  bundles: BundleRepository;
}

/** The repositories this service needs, or a clear failure when the store has none (D218). */
export function skillRepositories(repository: Repository): SkillRepositories {
  const { skills, bundles } = repository;
  if (skills === undefined || bundles === undefined) {
    throw new Error('The repository has no skill storage (ACE parity P1).');
  }
  return { skills, bundles };
}

/** How long a bundle's name may be inside the suffix that keeps a clashing skill name unique. */
const SUFFIX_LABEL_MAX = 40;
/** A name search that gives up rather than spin: thousands of copies of one skill is a bug. */
const MAX_NAME_ATTEMPTS = 1000;

const nameTaken = (name: string): HttpError =>
  new HttpError(
    'invalid_config',
    'name_taken',
    `A skill named "${name}" is already installed. Choose another name.`,
    { name },
  );

const readOnly = (skill: Skill): HttpError =>
  new HttpError(
    'invalid_config',
    'skill_read_only',
    `"${skill.name}" is a built-in skill and cannot be changed. Duplicate it to make your own copy.`,
    { id: skill.id },
  );

const shorten = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

export function createSkillService(deps: SkillServiceDeps): SkillService {
  const { repository, scope } = deps;
  // Resolved once, so a store without skills fails at start-up rather than on the first request.
  const { skills: liveSkills, bundles: liveBundles } = skillRepositories(repository);
  const now = deps.now ?? (() => new Date().toISOString());
  const nextId = deps.nextId ?? newId;

  async function load(skills: SkillRepository, id: Id): Promise<Skill> {
    const skill = await skills.get(scope, id);
    if (skill === null) throw notFound(`Skill ${id}`);
    return skill;
  }

  async function requireFreeName(skills: SkillRepository, name: string, self?: Id): Promise<void> {
    const holder = await skills.getByName(scope, name);
    if (holder !== null && holder.id !== self) throw nameTaken(name);
  }

  /**
   * The first of `base + suffix(1)`, `base + suffix(2)`, … that no skill has. The base is cut, not
   * the suffix, so the result always fits the contract's name length.
   */
  async function freeName(
    skills: SkillRepository,
    base: string,
    suffix: (attempt: number) => string,
  ): Promise<string> {
    for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt += 1) {
      const tail = suffix(attempt);
      const candidate = `${base.slice(0, SKILL_NAME_MAX - tail.length).trimEnd()}${tail}`;
      if ((await skills.getByName(scope, candidate)) === null) return candidate;
    }
    throw nameTaken(base);
  }

  return {
    list: () => liveSkills.list(scope),

    get: (id) => load(liveSkills, id),

    create: (body) =>
      repository.transaction(async (tx) => {
        const { skills } = skillRepositories(tx);
        await requireFreeName(skills, body.name);
        const at = now();
        return skills.create(scope, {
          id: nextId(),
          name: body.name,
          description: body.description ?? '',
          instructions: body.instructions,
          version: 1,
          source: 'user',
          createdAt: at,
          updatedAt: at,
        });
      }),

    update: (id, patch) =>
      repository.transaction(async (tx) => {
        const { skills } = skillRepositories(tx);
        const current = await load(skills, id);
        if (current.source === 'builtin') throw readOnly(current);

        const name = patch.name ?? current.name;
        const instructions = patch.instructions ?? current.instructions;
        const description = patch.description ?? current.description;
        const contentChanged = name !== current.name || instructions !== current.instructions;
        if (!contentChanged && description === current.description) return current;
        if (name !== current.name) await requireFreeName(skills, name, id);

        return skills.save(scope, {
          ...current,
          name,
          description,
          instructions,
          version: contentChanged ? current.version + 1 : current.version,
          updatedAt: now(),
        });
      }),

    remove: async (id) => {
      await repository.transaction(async (tx) => {
        const { skills } = skillRepositories(tx);
        const current = await load(skills, id);
        if (current.source === 'builtin') throw readOnly(current);
        await skills.delete(scope, id);
      });
    },

    duplicate: (id) =>
      repository.transaction(async (tx) => {
        const { skills } = skillRepositories(tx);
        const original = await load(skills, id);
        const name = await freeName(skills, original.name, (attempt) =>
          attempt === 1 ? ' (copy)' : ` (copy ${attempt})`,
        );
        const at = now();
        return skills.create(scope, {
          id: nextId(),
          name,
          description: original.description,
          instructions: original.instructions,
          version: 1,
          source: 'user',
          createdAt: at,
          updatedAt: at,
        });
      }),

    ensureBuiltinSkills: () =>
      repository.transaction(async (tx) => {
        const { skills } = skillRepositories(tx);
        const inserted: Skill[] = [];
        for (const builtin of BUILTIN_SKILLS) {
          const stored = await skills.get(scope, builtin.id);
          if (stored === null) {
            // A skill of the user's already has this name: theirs keeps it, and the built-in waits
            // until the name is free rather than failing every start.
            if ((await skills.getByName(scope, builtin.name)) !== null) continue;
            inserted.push(await skills.create(scope, builtin));
          } else if (stored.source === 'builtin' && stored.version < builtin.version) {
            // A release revised the built-in: the stored copy follows, keeping when it arrived.
            await skills.save(scope, { ...builtin, createdAt: stored.createdAt });
          }
        }
        return inserted;
      }),

    listBundles: () => liveBundles.list(scope),

    importBundle: (file) =>
      repository.transaction(async (tx) => {
        const { skills, bundles } = skillRepositories(tx);
        const bundleId = nextId();
        const at = now();
        const label = shorten(file.name, SUFFIX_LABEL_MAX);

        const skillIds: Id[] = [];
        for (const entry of file.skills) {
          const taken = (await skills.getByName(scope, entry.name)) !== null;
          const name = taken
            ? await freeName(skills, entry.name, (attempt) =>
                attempt === 1 ? ` (${label})` : ` (${label} ${attempt})`,
              )
            : entry.name;
          const created = await skills.create(scope, {
            id: nextId(),
            name,
            description: entry.description ?? '',
            instructions: entry.instructions,
            version: 1,
            source: 'bundle',
            bundleId,
            createdAt: at,
            updatedAt: at,
          });
          skillIds.push(created.id);
        }

        // D273: the definitions are recorded as the file named them. Nothing is connected here.
        return bundles.create(scope, {
          id: bundleId,
          name: file.name,
          description: file.description ?? '',
          skillIds,
          mcpServers: file.mcpServers ?? [],
          createdAt: at,
        });
      }),

    removeBundle: async (id) => {
      await repository.transaction(async (tx) => {
        const { skills, bundles } = skillRepositories(tx);
        if ((await bundles.get(scope, id)) === null) throw notFound(`Bundle ${id}`);
        for (const skill of await skills.list(scope)) {
          if (skill.source === 'bundle' && skill.bundleId === id) {
            await skills.delete(scope, skill.id);
          }
        }
        await bundles.delete(scope, id);
      });
    },
  };
}
