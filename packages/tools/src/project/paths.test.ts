import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ToolError } from '../errors.js';
import { RecordingToolLogger } from '../logging.js';
import { assertInsideProject, assertWritable, projectRelative } from './paths.js';

let root: string;
let project: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ace-project-'));
  project = join(root, 'my project');
  mkdirSync(join(project, 'src'), { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const resolveIn = (candidate: string | undefined) =>
  assertInsideProject({
    projectDir: project,
    candidate,
    toolName: 'write_file',
    operation: 'write',
    logger: new RecordingToolLogger(),
    runId: 'run-1',
  });

describe('FR-TOOL-008 paths stay inside the project folder', () => {
  it('resolves a relative path, and the root itself', () => {
    expect(resolveIn('src/math.js')).toBe(join(resolve(project), 'src', 'math.js'));
    expect(resolveIn(undefined)).toBe(resolve(project));
    expect(resolveIn('.')).toBe(resolve(project));
  });

  it('TC-TOOL-009 refuses a write to the parent folder, an absolute path and a home path', () => {
    for (const candidate of ['../outside.txt', 'src/../../outside.txt', resolve(root, 'x.txt'), '~/x']) {
      expect(() => resolveIn(candidate), candidate).toThrow(ToolError);
    }
  });

  it('refuses when the run has no project folder', () => {
    expect(() =>
      assertInsideProject({ projectDir: undefined, candidate: 'a', toolName: 'read_file', operation: 'read', logger: new RecordingToolLogger(), runId: 'r' }),
    ).toThrow(/needs a project folder/);
  });

  it('keeps writes out of .git and .ace', () => {
    expect(() => assertWritable(project, join(project, '.git', 'config'), 'write_file')).toThrow(/\.git/);
    expect(() => assertWritable(project, join(project, '.ace', 'x'), 'write_file')).toThrow(/\.ace/);
    expect(() => assertWritable(project, join(project, 'src', 'a.js'), 'write_file')).not.toThrow();
  });

  it('shows paths to the model relative, with forward slashes', () => {
    expect(projectRelative(project, join(project, 'src', 'a.js'))).toBe('src/a.js');
    expect(projectRelative(project, project)).toBe('.');
  });
});
