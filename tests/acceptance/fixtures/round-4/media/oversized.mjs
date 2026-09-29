import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Generates the oversized upload fixture for TC-MM-001 (round 4 §4 item 6): a file larger than the
 * default 100 MB upload cap, so `POST /artifacts` answers 413 `upload_too_large`. It is 150 MB and
 * therefore NEVER committed — a test makes it on demand and deletes it afterwards.
 *
 * As a module:
 *   import { makeOversizedFile, OVERSIZED_MB } from '.../media/oversized.mjs';
 *   const path = makeOversizedFile();            // -> a 150 MB file in the OS temp dir
 *   const path = makeOversizedFile({ dir, sizeMb, name });
 *   // ... upload it, assert 413, then fs.rm(path)
 *
 * As a CLI (prints the path it wrote):
 *   node tests/acceptance/fixtures/round-4/media/oversized.mjs [path] [sizeMb]
 *
 * The bytes are written in chunks so a 150 MB file never sits in memory whole. Its type is
 * `application/zip` by extension (`.zip`) so it clears the allow-list and is refused on size alone,
 * not type — the point of the test is the 413, not a 415.
 */

/** The size that clears the 100 MB default cap (`DEFAULT_MAX_UPLOAD_MB`) with margin. */
export const OVERSIZED_MB = 150;

const CHUNK = Buffer.alloc(1024 * 1024, 0); // 1 MB of zeros, reused for every write

/**
 * Writes an oversized file and returns its absolute path. `dir` defaults to the OS temp directory,
 * `sizeMb` to 150, `name` to `oversized-<sizeMb>mb.zip`.
 */
export function makeOversizedFile({ dir = tmpdir(), sizeMb = OVERSIZED_MB, name } = {}) {
  const target = join(dir, name ?? `oversized-${sizeMb}mb.zip`);
  mkdirSync(dirname(target), { recursive: true });

  const fd = openSync(target, 'w');
  try {
    for (let written = 0; written < sizeMb; written += 1) writeSync(fd, CHUNK);
  } finally {
    closeSync(fd);
  }
  return target;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const [pathArg, sizeArg] = process.argv.slice(2);
  const sizeMb = sizeArg ? Number(sizeArg) : OVERSIZED_MB;
  const options = {};
  if (pathArg) {
    options.dir = dirname(pathArg);
    options.name = pathArg.slice(dirname(pathArg).length + 1);
  }
  options.sizeMb = sizeMb;
  const path = makeOversizedFile(options);
  console.log(path);
}
