import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createFsProjectFiles } from './project-files.js';

describe('D299 the ProjectFiles adapter on disk', () => {
  it('answers every port method over one folder', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ace-adapter-'));
    try {
      writeFileSync(join(root, 'a.txt'), 'hello');
      const files = createFsProjectFiles();

      expect((await files.listFolder(root, '')).items.map((e) => e.name)).toEqual(['a.txt']);
      expect((await files.read(root, 'a.txt')).kind).toBe('text');
      expect((await files.listAll(root)).files).toEqual(['a.txt']);
      expect((await files.status(root)).repo).toBe(false);
      const stop = files.watch(
        root,
        () => undefined,
        () => undefined,
      );
      expect(typeof stop).toBe('function');
      stop();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
