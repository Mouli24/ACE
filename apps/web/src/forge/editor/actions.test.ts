import { aceError } from '@ace/contracts';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mockVersion } from '../../mocks/files';
import { db, installMockServer, queryClient, server } from '../../test/app';
import { useOutputStore } from '../panel/output-store';
import { dirtyHandler, keepMine, openFile, saveFile, takeTheirs } from './actions';
import { useEditorStore } from './editor-store';
import { ensureModel, getModel, replaceContent } from './models';

installMockServer();

let projectId: string;
const file = () => useEditorStore.getState().projects[projectId]?.files['a.ts'];
const disk = () => db.filesOf(projectId)['a.ts']?.content;
const output = () =>
  (useOutputStore.getState().lines[projectId] ?? []).map(
    (line) => `${line.level}: ${line.message}`,
  );

/** What the host does when a file opens: a model over the disk's text, and its base version. */
function openOnDisk(content: string) {
  db.seedFiles(projectId, { 'a.ts': content });
  openFile(projectId, 'a.ts');
  const model = ensureModel(
    projectId,
    'a.ts',
    content,
    'typescript',
    dirtyHandler(projectId, 'a.ts'),
  );
  useEditorStore.getState().loaded(projectId, 'a.ts', mockVersion(content), false);
  return model;
}

beforeEach(() => {
  projectId = db.createProject({ name: 'P' }).id;
});

describe('D299 FR-GIT-004 saving', () => {
  it('saves the buffer against its base and marks it clean', async () => {
    const model = openOnDisk('one');
    model.setValue('two');
    expect(file()?.dirty).toBe(true);

    expect(await saveFile(projectId, 'a.ts', queryClient)).toBe(true);

    expect(disk()).toBe('two');
    expect(file()).toMatchObject({ dirty: false, saving: false, baseVersion: mockVersion('two') });
    expect(output()).toContain('info: Saved a.ts');
  });

  it('never overwrites silently: a stale base raises the conflict and the disk keeps its text', async () => {
    const model = openOnDisk('one');
    model.setValue('mine');
    db.writeFileExternally(projectId, 'a.ts', 'theirs');

    expect(await saveFile(projectId, 'a.ts', queryClient)).toBe(false);

    expect(disk()).toBe('theirs');
    expect(file()).toMatchObject({ conflict: 'changed', dirty: true });
    expect(output().some((line) => line.startsWith('warn: a.ts changed on disk'))).toBe(true);
  });

  it('typing during a save stays unsaved', async () => {
    const model = openOnDisk('one');
    model.setValue('sent');
    db.setLatency(30);
    const saving = saveFile(projectId, 'a.ts', queryClient);
    model.setValue('typed meanwhile');
    await saving;
    expect(disk()).toBe('sent');
    expect(file()?.dirty).toBe(true);
  });

  it('a failed save keeps the buffer unsaved and says why', async () => {
    server.use(
      http.put('*/api/v1/projects/:id/files/content', () =>
        HttpResponse.json(
          aceError('provider', 'internal', 'The engine hit an unexpected error.', {
            retryable: false,
          }),
          { status: 500 },
        ),
      ),
    );
    const model = openOnDisk('one');
    model.setValue('two');
    expect(await saveFile(projectId, 'a.ts', queryClient)).toBe(false);
    expect(file()).toMatchObject({ dirty: true, error: 'The engine hit an unexpected error.' });
    expect(output()).toContain('error: Could not save a.ts: The engine hit an unexpected error.');
  });
});

describe('D299 §5.4 resolving a conflict', () => {
  it('Keep mine takes the disk’s version as the base, so the next save wins', async () => {
    const model = openOnDisk('one');
    model.setValue('mine');
    db.writeFileExternally(projectId, 'a.ts', 'theirs');
    await saveFile(projectId, 'a.ts', queryClient);

    await keepMine(projectId, 'a.ts', queryClient);
    expect(file()).toMatchObject({
      conflict: undefined,
      dirty: true,
      baseVersion: mockVersion('theirs'),
    });
    expect(await saveFile(projectId, 'a.ts', queryClient)).toBe(true);
    expect(disk()).toBe('mine');
  });

  it('Take theirs replaces the buffer with the disk and closes the conflict', async () => {
    const model = openOnDisk('one');
    model.setValue('mine');
    db.writeFileExternally(projectId, 'a.ts', 'theirs');
    await saveFile(projectId, 'a.ts', queryClient);

    await takeTheirs(projectId, 'a.ts', queryClient);
    expect(getModel(projectId, 'a.ts')?.getValue()).toBe('theirs');
    expect(file()).toMatchObject({
      conflict: undefined,
      dirty: false,
      baseVersion: mockVersion('theirs'),
    });
  });

  it('Take theirs on a file deleted on disk closes its tab', async () => {
    const model = openOnDisk('one');
    model.setValue('mine');
    db.deleteFileExternally(projectId, 'a.ts');
    await takeTheirs(projectId, 'a.ts', queryClient);
    expect(file()).toBeUndefined();
  });
});

describe('D299 §6.2 a clean buffer following the disk', () => {
  it('never reports dirty, so a previewed file stays a preview', () => {
    db.seedFiles(projectId, { 'a.ts': 'one' });
    openFile(projectId, 'a.ts', { preview: true });
    ensureModel(projectId, 'a.ts', 'one', 'typescript', dirtyHandler(projectId, 'a.ts'));
    useEditorStore.getState().loaded(projectId, 'a.ts', mockVersion('one'), false);
    const setDirty = vi.spyOn(useEditorStore.getState(), 'setDirty');
    replaceContent(projectId, 'a.ts', 'theirs');
    expect(setDirty).not.toHaveBeenCalledWith(projectId, 'a.ts', true);
    expect(useEditorStore.getState().projects[projectId]?.preview).toBe('a.ts');
    expect(file()?.dirty).toBe(false);
    expect(getModel(projectId, 'a.ts')?.getValue()).toBe('theirs');
  });
});
