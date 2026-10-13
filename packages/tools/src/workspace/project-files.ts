import type { ProjectFiles } from '@ace/engine';

import {
  createEntry,
  listAllFiles,
  listFolder,
  moveEntry,
  readFile,
  readRaw,
  removeEntry,
  writeFile,
} from './fs-files.js';
import { readRepoStatus } from './repo-status.js';
import { searchFiles } from './search.js';
import { readSources } from './sources.js';
import { watchProject } from './watcher.js';

/** Forge's `ProjectFiles` port on the real file system (D299); `apps/server` wires it. */
export function createFsProjectFiles(): ProjectFiles {
  return {
    listFolder,
    read: readFile,
    readRaw: (root, path) => readRaw(root, path),
    write: writeFile,
    create: createEntry,
    move: moveEntry,
    remove: removeEntry,
    listAll: (root) => listAllFiles(root),
    status: (root) => readRepoStatus(root),
    search: (root, request) => searchFiles(root, request),
    readSources: (root, options) => readSources(root, options),
    watch: (root, onChange, onError) => watchProject(root, onChange, onError),
  };
}
