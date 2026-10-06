import { readFileSync, statSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';

/**
 * Turns a CLI name into something `spawn` can start **without a shell** (X1 §5, Node DEP0190).
 *
 * npm installs a CLI on Windows as a `.cmd` shim, which only a shell can run. A shim is a few lines
 * that end by calling the real program — a native `.exe`, or `node` on a `.js` entry point — so the
 * shim is read and its target spawned directly. A `.cmd` that cannot be unwrapped is skipped: a
 * shell is exactly what this exists to avoid (review focus 1).
 */
export interface ResolvedCommand {
  /** The executable to spawn. */
  command: string;
  /** Arguments that go before the CLI's own — the script path when `command` is node. */
  prefixArgs: string[];
  /** The file found on PATH, for display. */
  path: string;
}

export interface ResolveOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** The Node binary that runs a `.js` entry point; the engine's own by default. */
  nodeBinary?: string;
}

const SCRIPT_EXTENSIONS = new Set(['.js', '.cjs', '.mjs']);

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The program an npm `.cmd` shim ends by running, or `undefined` when it names none we can find. */
function shimTarget(shim: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(shim, 'utf8');
  } catch {
    return undefined;
  }
  const matches = [...text.matchAll(/"%~?dp0%?([^"]+?\.(?:exe|cjs|mjs|js))"/gi)];
  const relative = matches.at(-1)?.[1];
  if (relative === undefined) return undefined;
  const target = join(dirname(shim), ...relative.split(/[\\/]+/).filter((part) => part !== ''));
  return isFile(target) ? target : undefined;
}

function toCommand(
  file: string,
  platform: NodeJS.Platform,
  nodeBinary: string,
): ResolvedCommand | undefined {
  const extension = extname(file).toLowerCase();
  if (platform === 'win32' && (extension === '.cmd' || extension === '.bat')) {
    const target = shimTarget(file);
    if (target === undefined) return undefined;
    return SCRIPT_EXTENSIONS.has(extname(target).toLowerCase())
      ? { command: nodeBinary, prefixArgs: [target], path: file }
      : { command: target, prefixArgs: [], path: file };
  }
  if (SCRIPT_EXTENSIONS.has(extension)) {
    return { command: nodeBinary, prefixArgs: [file], path: file };
  }
  return { command: file, prefixArgs: [], path: file };
}

export function resolveCommand(
  name: string,
  options: ResolveOptions = {},
): ResolvedCommand | undefined {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const nodeBinary = options.nodeBinary ?? process.execPath;
  const pathValue = env['PATH'] ?? env['Path'] ?? '';
  const pathExt = (env['PATHEXT'] ?? '').toLowerCase().split(';').filter((ext) => ext !== '');
  const extensions = platform === 'win32' ? [...new Set(['.exe', '.cmd', '.bat', ...pathExt])] : [''];

  for (const dir of pathValue.split(platform === 'win32' ? ';' : ':')) {
    if (dir.trim() === '') continue;
    for (const extension of extensions) {
      const candidate = join(dir, `${name}${extension}`);
      if (!isFile(candidate)) continue;
      const command = toCommand(candidate, platform, nodeBinary);
      if (command !== undefined) return command;
    }
  }
  return undefined;
}
