import {
  SKILL_NAME_MAX,
  type Bundle,
  type BundleFile,
  type CreateSkillRequest,
  type ErrorKind,
  type Skill,
  type UpdateSkillRequest,
} from '@ace/contracts';

import type { MockDb } from './db';

/**
 * The mock skills engine (ACE parity P1, D272, D273), mirroring `packages/engine/src/skills`:
 * names unique case-insensitively (409 `name_taken`), built-ins read-only (409 `skill_read_only`),
 * a version bump when the name or the instructions change, "(copy)" duplicates, and a bundle
 * import that installs skills and records — never connects — its MCP server definitions.
 */

export class SkillEngineError extends Error {
  constructor(
    readonly status: number,
    readonly kind: ErrorKind,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const now = (): string => new Date().toISOString();

const notFound = (what: string) =>
  new SkillEngineError(404, 'workflow', 'not_found', `${what} was not found.`);

const nameTaken = (name: string) =>
  new SkillEngineError(
    409,
    'invalid_config',
    'name_taken',
    `A skill named "${name}" is already installed. Choose another name.`,
  );

const readOnly = (skill: Skill) =>
  new SkillEngineError(
    409,
    'invalid_config',
    'skill_read_only',
    `"${skill.name}" is a built-in skill and cannot be changed. Duplicate it to make your own copy.`,
  );

function load(db: MockDb, id: string): Skill {
  const skill = db.getSkill(id);
  if (skill === undefined) throw notFound(`Skill ${id}`);
  return skill;
}

function requireFreeName(db: MockDb, name: string, self?: string): void {
  const holder = db.findSkillByName(name);
  if (holder !== undefined && holder.id !== self) throw nameTaken(name);
}

/** The first of `base + suffix(1)`, `base + suffix(2)`, … no skill has, cut to the name limit. */
function freeName(db: MockDb, base: string, suffix: (attempt: number) => string): string {
  for (let attempt = 1; attempt <= 1000; attempt += 1) {
    const tail = suffix(attempt);
    const candidate = `${base.slice(0, SKILL_NAME_MAX - tail.length).trimEnd()}${tail}`;
    if (db.findSkillByName(candidate) === undefined) return candidate;
  }
  throw nameTaken(base);
}

const shorten = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

/** Built-in skills first, then the rest by name. */
export function listSkills(db: MockDb): Skill[] {
  return db
    .listSkills()
    .sort(
      (a, b) =>
        Number(b.source === 'builtin') - Number(a.source === 'builtin') ||
        a.name.toLowerCase().localeCompare(b.name.toLowerCase()) ||
        a.id.localeCompare(b.id),
    );
}

export function getSkill(db: MockDb, id: string): Skill {
  return load(db, id);
}

export function createSkill(db: MockDb, body: CreateSkillRequest): Skill {
  requireFreeName(db, body.name);
  const at = now();
  return db.putSkill({
    id: db.nextId(),
    name: body.name,
    description: body.description ?? '',
    instructions: body.instructions,
    version: 1,
    source: 'user',
    createdAt: at,
    updatedAt: at,
  });
}

export function updateSkill(db: MockDb, id: string, patch: UpdateSkillRequest): Skill {
  const current = load(db, id);
  if (current.source === 'builtin') throw readOnly(current);
  const name = patch.name ?? current.name;
  const instructions = patch.instructions ?? current.instructions;
  const description = patch.description ?? current.description;
  const contentChanged = name !== current.name || instructions !== current.instructions;
  if (!contentChanged && description === current.description) return current;
  if (name !== current.name) requireFreeName(db, name, id);
  return db.putSkill({
    ...current,
    name,
    description,
    instructions,
    version: contentChanged ? current.version + 1 : current.version,
    updatedAt: now(),
  });
}

export function deleteSkill(db: MockDb, id: string): void {
  const current = load(db, id);
  if (current.source === 'builtin') throw readOnly(current);
  db.deleteSkill(id);
}

export function duplicateSkill(db: MockDb, id: string): Skill {
  const original = load(db, id);
  const at = now();
  return db.putSkill({
    id: db.nextId(),
    name: freeName(db, original.name, (attempt) =>
      attempt === 1 ? ' (copy)' : ` (copy ${attempt})`,
    ),
    description: original.description,
    instructions: original.instructions,
    version: 1,
    source: 'user',
    createdAt: at,
    updatedAt: at,
  });
}

/** Oldest first. */
export function listBundles(db: MockDb): Bundle[] {
  return db
    .listBundles()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

/** D273: installs the skills (a clash gets " (<bundle name>)"), connects nothing. */
export function importBundle(db: MockDb, file: BundleFile): Bundle {
  const bundleId = db.nextId();
  const at = now();
  const label = shorten(file.name, 40);
  const skillIds = file.skills.map((entry) => {
    const name =
      db.findSkillByName(entry.name) === undefined
        ? entry.name
        : freeName(db, entry.name, (attempt) =>
            attempt === 1 ? ` (${label})` : ` (${label} ${attempt})`,
          );
    return db.putSkill({
      id: db.nextId(),
      name,
      description: entry.description ?? '',
      instructions: entry.instructions,
      version: 1,
      source: 'bundle',
      bundleId,
      createdAt: at,
      updatedAt: at,
    }).id;
  });
  return db.addBundle({
    id: bundleId,
    name: file.name,
    description: file.description ?? '',
    skillIds,
    mcpServers: file.mcpServers ?? [],
    createdAt: at,
  });
}

/** The bundle and the skills it installed; servers the user connected stay connected. */
export function deleteBundle(db: MockDb, id: string): void {
  if (db.getBundle(id) === undefined) throw notFound(`Bundle ${id}`);
  for (const skill of db.listSkills()) {
    if (skill.source === 'bundle' && skill.bundleId === id) db.deleteSkill(skill.id);
  }
  db.deleteBundle(id);
}
