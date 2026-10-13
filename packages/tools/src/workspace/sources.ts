import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  FILE_LIST_LIMIT,
  SOURCE_EXTENSIONS,
  SOURCES_MAX_BYTES,
  SOURCES_MAX_FILES,
  type SourceFile,
  type SourcesResult,
} from '@ace/contracts';

import { listAllFiles } from './fs-files.js';

/** How much of a file is searched for a NUL byte to call it binary — git's own heuristic. */
const SNIFF_BYTES = 8000;
/** A root `tsconfig.json` larger than this is not one anybody wrote by hand; it is left out. */
const TSCONFIG_MAX_BYTES = 256 * 1024;

export interface ReadSourcesOptions {
  /** Extensions without the dot; `ts` covers `.d.ts`. Default {@link SOURCE_EXTENSIONS}. */
  exts?: readonly string[];
  maxFiles?: number;
  maxBytes?: number;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const depthOf = (path: string): number => path.split('/').length;

async function readText(absolute: string, maxBytes: number): Promise<Buffer | undefined> {
  try {
    const stats = await fs.stat(absolute);
    if (!stats.isFile() || stats.size > maxBytes) return undefined;
    const bytes = await fs.readFile(absolute);
    return bytes.subarray(0, SNIFF_BYTES).includes(0) ? undefined : bytes;
  } catch {
    return undefined;
  }
}

const textOf = (bytes: Buffer): string => {
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  return bytes.subarray(bom ? 3 : 0).toString('utf8');
};

/**
 * The project's TS/JS sources for Monaco's cross-file IntelliSense (D299 Phase 4, design §6.2): the
 * files the Explorer does not ignore — never `node_modules` — with one of `exts`, shallowest first
 * and then by name, read whole until `maxFiles` files or `maxBytes` bytes (UTF-8) would be passed;
 * then it stops and says `truncated`. Binary files are skipped. The root `tsconfig.json` comes too,
 * as text, for its `compilerOptions`; it does not count against the caps.
 */
export async function readSources(
  root: string,
  options: ReadSourcesOptions = {},
): Promise<SourcesResult> {
  const base = resolve(root);
  const exts = new Set((options.exts ?? SOURCE_EXTENSIONS).map((ext) => ext.toLowerCase()));
  const maxFiles = options.maxFiles ?? SOURCES_MAX_FILES;
  const maxBytes = options.maxBytes ?? SOURCES_MAX_BYTES;

  const list = await listAllFiles(base, FILE_LIST_LIMIT);
  const candidates = list.files
    .filter((path) => {
      if (path.split('/').some((segment) => segment.toLowerCase() === 'node_modules')) return false;
      const dot = path.lastIndexOf('.');
      return dot > path.lastIndexOf('/') && exts.has(path.slice(dot + 1).toLowerCase());
    })
    .sort((a, b) => depthOf(a) - depthOf(b) || collator.compare(a, b));

  const files: SourceFile[] = [];
  let bytes = 0;
  let truncated = list.truncated;
  for (const path of candidates) {
    if (files.length >= maxFiles) {
      truncated = true;
      break;
    }
    const read = await readText(join(base, path), maxBytes);
    if (read === undefined) continue;
    if (bytes + read.length > maxBytes) {
      truncated = true;
      break;
    }
    bytes += read.length;
    files.push({ path, content: textOf(read) });
  }

  const tsconfig = await readText(join(base, 'tsconfig.json'), TSCONFIG_MAX_BYTES);
  return { files, truncated, ...(tsconfig === undefined ? {} : { tsconfig: textOf(tsconfig) }) };
}
