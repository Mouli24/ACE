import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import ignoreModule, { type Ignore } from 'ignore';

// `ignore` is CommonJS; under NodeNext its types make the default import the module itself, and
// the package sets `factory.default = factory` for exactly this case.
const ignore = ignoreModule.default;

/** Never listed at all: git's own data (VS Code hides it too). Matched case-insensitively. */
export const HIDDEN_NAMES: ReadonlySet<string> = new Set(['.git']);

/**
 * Listed dimmed, and skipped by quick open's list and by the watcher, exactly like a `.gitignore`
 * match (design §5.1's excludes): folders nobody edits by hand and that can hold 100k files.
 */
export const DEFAULT_IGNORED_FOLDERS: ReadonlySet<string> = new Set([
  'node_modules',
  '.ace',
  'dist',
  'build',
  '.next',
  '__pycache__',
  '.venv',
]);

export interface IgnoreRules {
  /** `rel` is project-relative, forward slashes, not empty. */
  isIgnored(rel: string, isFolder: boolean): boolean;
  isHidden(rel: string): boolean;
  /** Forget the cached `.gitignore` files (one of them changed). */
  clear(): void;
}

/**
 * `.gitignore` semantics for one project folder: the root file and every nested one, each applied
 * to the paths below its own folder, plus {@link DEFAULT_IGNORED_FOLDERS}. Files are read lazily
 * and cached; a pattern that ignores a folder ignores everything under it, as git does.
 * Approximation: a `!` re-include in a nested file cannot undo a parent folder's exclusion (git
 * cannot either).
 */
export function createIgnoreRules(root: string): IgnoreRules {
  const cache = new Map<string, Ignore | null>();

  function rulesIn(folder: string): Ignore | null {
    const cached = cache.get(folder);
    if (cached !== undefined) return cached;
    let rules: Ignore | null;
    try {
      rules = ignore().add(readFileSync(join(root, folder, '.gitignore'), 'utf8'));
    } catch {
      rules = null;
    }
    cache.set(folder, rules);
    return rules;
  }

  return {
    isHidden: (rel) => rel.split('/').some((segment) => HIDDEN_NAMES.has(segment.toLowerCase())),

    isIgnored(rel, isFolder) {
      const segments = rel.split('/');
      for (let i = 0; i < segments.length; i += 1) {
        const folderSegment = i < segments.length - 1 || isFolder;
        if (folderSegment && DEFAULT_IGNORED_FOLDERS.has(segments[i] ?? '')) return true;
      }
      // Each .gitignore from the root down to the entry's parent, tested against every path from
      // that .gitignore's folder down to the entry.
      for (let depth = 0; depth < segments.length; depth += 1) {
        const rules = rulesIn(segments.slice(0, depth).join('/'));
        if (rules === null) continue;
        for (let end = depth + 1; end <= segments.length; end += 1) {
          const sub = segments.slice(depth, end).join('/');
          const subIsFolder = end < segments.length || isFolder;
          if (rules.ignores(subIsFolder ? `${sub}/` : sub)) return true;
        }
      }
      return false;
    },

    clear: () => cache.clear(),
  };
}
