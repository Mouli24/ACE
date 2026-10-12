import { readFile, stat } from 'node:fs/promises';

import {
  PACKAGE_MANAGERS,
  type PackageManager,
  type ProjectScript,
  type ProjectScripts,
} from '@ace/contracts';

import { toAbsolute } from '../workspace/resolve.js';

/**
 * The project's own scripts for the terminal's script buttons and its `scripts` trust level
 * (D301, design §6.3): the root package.json's `scripts`, and the package manager they run with —
 * the `packageManager` field first, then the lockfiles in this order, then npm.
 */
export const LOCKFILES: ReadonlyArray<readonly [file: string, manager: PackageManager]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
];

/**
 * A script name the terminal may run as `<pm> run <name>` (D301). Task 6 hands the line to the
 * platform shell, so a name with a metacharacter (`x & del *`) must never be offered or accepted.
 */
export const SAFE_SCRIPT_NAME = /^[\w@][\w:.@/+-]{0,199}$/;

/** A larger package.json is not read: it would stall the engine, and no real one is that big. */
export const PACKAGE_JSON_MAX_BYTES = 1_048_576;

/** A file in the project root, read only when it resolves inside the project (FR-GIT-008). */
async function rootText(root: string, name: string): Promise<string | undefined> {
  try {
    const path = toAbsolute(root, name);
    if ((await stat(path)).size > PACKAGE_JSON_MAX_BYTES) return undefined;
    return await readFile(path, 'utf8');
  } catch {
    // Missing, a folder, unreadable, or a link out of the project: no answer, never an error.
    return undefined;
  }
}

async function rootFileExists(root: string, name: string): Promise<boolean> {
  try {
    return (await stat(toAbsolute(root, name))).isFile();
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `"pnpm@9.15.9+sha512.…"` → `pnpm`. A manager D301 does not name is no answer. */
function managerNamed(field: unknown): PackageManager | undefined {
  if (typeof field !== 'string') return undefined;
  const name = field.split('@')[0]?.trim();
  return PACKAGE_MANAGERS.find((manager) => manager === name);
}

function parsed(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    // A byte-order mark is legal in a file and fatal to JSON.parse.
    return JSON.parse(text.replace(/^\uFEFF/, '')) as unknown;
  } catch {
    return undefined;
  }
}

export async function readProjectScripts(root: string): Promise<ProjectScripts> {
  const manifest = parsed(await rootText(root, 'package.json'));
  const scripts: ProjectScript[] = [];
  if (isRecord(manifest) && isRecord(manifest['scripts'])) {
    for (const [name, command] of Object.entries(manifest['scripts'])) {
      // `__proto__` is a legal own key in parsed JSON and a hazard for anyone who copies the list.
      if (typeof command === 'string' && name !== '__proto__' && SAFE_SCRIPT_NAME.test(name)) {
        scripts.push({ name, command });
      }
    }
  }
  let packageManager = isRecord(manifest) ? managerNamed(manifest['packageManager']) : undefined;
  for (const [file, manager] of LOCKFILES) {
    if (packageManager !== undefined) break;
    if (await rootFileExists(root, file)) packageManager = manager;
  }
  return { packageManager: packageManager ?? 'npm', scripts };
}
