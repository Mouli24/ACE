import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * A file a `code_sandbox` run left behind, by path relative to the sandbox folder and its size.
 *
 * The tool layer stops here on purpose. §2.2 types `code_sandbox` output as `files: Artifact[]`, but
 * turning a file into an `Artifact` (hashing, dedupe, a row, retention) is the artifact store's job
 * in `packages/engine` — reachable from a tool would be a way around the permissions in its own
 * `ToolDefinition`. So the tool reports *which* files appeared and how big they are, and the node
 * executor stores them as artifacts as it logs the call. See the report's contract note.
 */
export interface ProducedFile {
  /** Path relative to the sandbox folder, always `/`-separated. */
  readonly path: string;
  readonly size: number;
}

/** How many produced files to report at most, so a program that writes thousands cannot flood. */
export const MAX_PRODUCED_FILES = 100;

/**
 * Walks `sandboxDir` and lists the files a run produced. Dot-prefixed names are skipped at every
 * level, which is what keeps the runner's own scaffolding (`.ace-run`, `.ace-deny`) out of the
 * result. Order is deterministic (sorted) so a logged summary does not churn between runs.
 */
export function collectProducedFiles(sandboxDir: string, limit = MAX_PRODUCED_FILES): ProducedFile[] {
  const found: ProducedFile[] = [];

  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      if (found.length >= limit) return;
      if (name.startsWith('.')) continue;
      const full = join(dir, name);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(full);
      } else if (stat.isFile()) {
        found.push({ path: relative(sandboxDir, full).split(sep).join('/'), size: stat.size });
      }
    }
  };

  walk(sandboxDir);
  return found.slice(0, limit);
}
