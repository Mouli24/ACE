import { aceError } from '@ace/contracts';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mockVersion, moveEntry } from '../../mocks/files';
import { db, installMockServer, queryClient, server } from '../../test/app';
import { useOutputStore } from '../panel/output-store';
import type * as Monaco from 'monaco-editor';

import {
  dirtyHandler,
  filesMoved,
  formatDocument,
  keepMine,
  openFile,
  saveAll,
  saveFile,
  takeTheirs,
} from './actions';
import { needsSaveAll, useEditorStore } from './editor-store';
import { ensureModel, getModel, replaceContent, setActiveEditor } from './models';

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

describe('review minor 2: a save that started during a move of the same file', () => {
  it('leaves the moved tab able to save again, still unsaved', async () => {
    const model = openOnDisk('one');
    model.setValue('two');
    db.setLatency(30);
    const saving = saveFile(projectId, 'a.ts', queryClient);
    expect(file()?.saving).toBe(true);
    // the move lands on disk and in the tabs before the save's answer
    moveEntry(db.filesOf(projectId), 'a.ts', 'b.ts');
    filesMoved(projectId, 'a.ts', 'b.ts');
    await saving;
    db.setLatency(0);

    const moved = () => useEditorStore.getState().projects[projectId]?.files['b.ts'];
    expect(moved()).toMatchObject({ saving: false, dirty: true, error: undefined });
    expect(await saveFile(projectId, 'b.ts', queryClient)).toBe(true);
    expect(db.filesOf(projectId)['b.ts']?.content).toBe('two');
  });

  it('a move clears a failed save’s message and the saving flag, never the unsaved mark', () => {
    const store = useEditorStore.getState();
    for (const path of ['src/a.ts', 'src/b.ts', 'other.ts', 'failed.ts']) {
      store.open(projectId, path);
      store.setDirty(projectId, path, true);
    }
    store.saveStarted(projectId, 'src/a.ts');
    store.saveFailed(projectId, 'src/b.ts', 'disk full');
    store.saveStarted(projectId, 'other.ts');
    store.saveFailed(projectId, 'failed.ts', 'disk full');
    store.renamed(projectId, 'src', 'lib');
    const files = useEditorStore.getState().projects[projectId]?.files;
    expect(files?.['lib/a.ts']).toMatchObject({ saving: false, dirty: true, error: undefined });
    expect(files?.['lib/b.ts']).toMatchObject({ saving: false, dirty: true, error: undefined });
    // files outside the move keep their own state
    expect(files?.['other.ts']).toMatchObject({ saving: true });
    expect(files?.['failed.ts']).toMatchObject({ error: 'disk full' });
  });
});

describe('review I1: Save all', () => {
  it('saves only the unsaved buffer; a clean tab deleted on disk stays deleted', async () => {
    db.seedFiles(projectId, { 'gone.ts': 'old', 'b.ts': 'one' });
    for (const [path, content] of [
      ['gone.ts', 'old'],
      ['b.ts', 'one'],
    ] as const) {
      openFile(projectId, path);
      ensureModel(projectId, path, content, 'typescript', dirtyHandler(projectId, path));
      useEditorStore.getState().loaded(projectId, path, mockVersion(content), false);
    }
    db.deleteFileExternally(projectId, 'gone.ts');
    useEditorStore.getState().markDeletedOnDisk(projectId, 'gone.ts');
    getModel(projectId, 'b.ts')?.setValue('two');

    await saveAll(projectId, queryClient);

    expect(db.filesOf(projectId)['gone.ts']).toBeUndefined();
    expect(db.filesOf(projectId)['b.ts']?.content).toBe('two');
    expect(useEditorStore.getState().projects[projectId]?.files['gone.ts']).toMatchObject({
      deletedOnDisk: true,
      dirty: false,
    });
  });

  it('leaves a buffer in conflict alone', async () => {
    const model = openOnDisk('one');
    model.setValue('mine');
    useEditorStore.getState().conflicted(projectId, 'a.ts', 'changed');
    await saveAll(projectId, queryClient);
    expect(disk()).toBe('one');
    expect(output().some((line) => line.startsWith('warn:'))).toBe(false);
  });

  it('wants saving only for an unsaved buffer that is not in conflict', () => {
    const base = {
      path: 'a.ts',
      baseVersion: 'v',
      bom: false,
      dirty: false,
      saving: false,
      conflict: undefined,
      deletedOnDisk: false,
      error: undefined,
    };
    expect(needsSaveAll(base)).toBe(false);
    expect(needsSaveAll({ ...base, deletedOnDisk: true, baseVersion: null })).toBe(false);
    expect(needsSaveAll({ ...base, dirty: true })).toBe(true);
    expect(needsSaveAll({ ...base, dirty: true, conflict: 'changed' })).toBe(false);
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

describe('D299 Phase 4 Format and format-on-save', () => {
  /**
   * An editor showing `model` whose Format Document rewrites the text as `format` says — Monaco's
   * formatters run through an editor, so the tests stand one in for the host's.
   */
  function attach(
    model: ReturnType<typeof openOnDisk>,
    format: (text: string) => string,
    supported = true,
  ) {
    const run = vi.fn(async () => model.setValue(format(model.getValue())));
    const editor = {
      getModel: () => model,
      getAction: (id: string) =>
        id === 'editor.action.formatDocument' ? { isSupported: () => supported, run } : null,
    };
    setActiveEditor(editor as unknown as Monaco.editor.ICodeEditor);
    return run;
  }
  const tidy = (text: string): string => text.replace(/\s*=\s*/g, ' = ');

  it('Format Document runs the editor’s formatter on the file it shows, and nothing else', async () => {
    const model = openOnDisk('a=1');
    expect(await formatDocument(projectId, 'a.ts')).toBe(false);
    const run = attach(model, tidy);
    expect(await formatDocument(projectId, 'a.ts')).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(model.getValue()).toBe('a = 1');
    expect(await formatDocument(projectId, 'other.ts')).toBe(false);
  });

  it('with format-on-save on, formats the active file first and saves the formatted text', async () => {
    db.updateProject(projectId, { formatOnSave: true });
    const model = openOnDisk('a=1');
    const run = attach(model, tidy);
    model.setValue('b=2');

    expect(await saveFile(projectId, 'a.ts', queryClient)).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(disk()).toBe('b = 2');
    expect(file()).toMatchObject({ dirty: false, baseVersion: mockVersion('b = 2') });
  });

  it('with format-on-save off, saves the text as typed', async () => {
    const model = openOnDisk('a=1');
    const run = attach(model, tidy);
    model.setValue('b=2');
    expect(await saveFile(projectId, 'a.ts', queryClient)).toBe(true);
    expect(run).not.toHaveBeenCalled();
    expect(disk()).toBe('b=2');
  });

  it('saves unchanged a file no editor shows, and a language with no formatter', async () => {
    db.updateProject(projectId, { formatOnSave: true });
    const model = openOnDisk('a=1');
    model.setValue('b=2');
    expect(await saveFile(projectId, 'a.ts', queryClient)).toBe(true);
    expect(disk()).toBe('b=2');

    const run = attach(model, tidy, false);
    model.setValue('c=3');
    expect(await saveFile(projectId, 'a.ts', queryClient)).toBe(true);
    expect(run).not.toHaveBeenCalled();
    expect(disk()).toBe('c=3');
  });

  it('Save all formats only the active file', async () => {
    db.updateProject(projectId, { formatOnSave: true });
    db.seedFiles(projectId, { 'b.ts': 'x=1' });
    const active = openOnDisk('a=1');
    openFile(projectId, 'b.ts');
    const other = ensureModel(
      projectId,
      'b.ts',
      'x=1',
      'typescript',
      dirtyHandler(projectId, 'b.ts'),
    );
    useEditorStore.getState().loaded(projectId, 'b.ts', mockVersion('x=1'), false);
    attach(active, tidy);
    active.setValue('a=2');
    other.setValue('x=2');

    await saveAll(projectId, queryClient);
    expect(disk()).toBe('a = 2');
    expect(db.filesOf(projectId)['b.ts']?.content).toBe('x=2');
  });

  /** A formatter that takes a moment, as the TS worker's does. */
  function attachSlow(model: ReturnType<typeof openOnDisk>) {
    const run = vi.fn(async () => {
      const before = model.getValue();
      await new Promise((settle) => setTimeout(settle, 40));
      model.setValue(tidy(before));
    });
    setActiveEditor({
      getModel: () => model,
      getAction: () => ({ isSupported: () => true, run }),
    } as unknown as Monaco.editor.ICodeEditor);
    return run;
  }

  /** Every save the engine received, as the text it was sent. */
  function savesSent(): string[] {
    const sent: string[] = [];
    server.events.on('request:start', ({ request }) => {
      if (request.method !== 'PUT' || !request.url.endsWith('/files/content')) return;
      void request
        .clone()
        .json()
        .then((body: { content: string }) => sent.push(body.content));
    });
    return sent;
  }

  it('fix I4: two quick saves under format-on-save raise no conflict, and write in order', async () => {
    db.updateProject(projectId, { formatOnSave: true });
    const model = openOnDisk('a=1');
    attachSlow(model);
    const sent = savesSent();
    model.setValue('b=2');

    const first = saveFile(projectId, 'a.ts', queryClient);
    const second = saveFile(projectId, 'a.ts', queryClient);
    expect(await first).toBe(true);
    expect(await second).toBe(true);

    expect(file()?.conflict).toBeUndefined();
    expect(file()).toMatchObject({ dirty: false, baseVersion: mockVersion('b = 2') });
    expect(disk()).toBe('b = 2');
    await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0));
    expect(sent).toEqual(['b = 2']);
    expect(output().some((line) => line.includes('changed on disk'))).toBe(false);
  });

  it('fix I4: typing between two saves is saved by the second, after the first', async () => {
    db.updateProject(projectId, { formatOnSave: true });
    const model = openOnDisk('a=1');
    attachSlow(model);
    const sent = savesSent();
    model.setValue('b=2');

    const first = saveFile(projectId, 'a.ts', queryClient);
    await new Promise((settle) => setTimeout(settle, 10));
    const second = saveFile(projectId, 'a.ts', queryClient);
    await first;
    model.setValue(`${model.getValue()}\nc=3`);
    await second;
    await saveFile(projectId, 'a.ts', queryClient);

    expect(file()?.conflict).toBeUndefined();
    expect(disk()).toBe('b = 2\nc = 3');
    await vi.waitFor(() => expect(sent).toEqual(['b = 2', 'b = 2\nc = 3']));
  });
});
