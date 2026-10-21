import { beforeEach, describe, expect, it, vi } from 'vitest';

import { asMonaco, createFakeMonaco } from '../../test/fake-monaco';
import {
  disposeModel,
  ensureModel,
  fileUri,
  getModel,
  isRegistryModel,
  onRegistryChange,
  markSaved,
  moveModels,
  pathOfUri,
  replaceContent,
  resetModels,
  setActiveEditor,
  setMonaco,
} from './models';

const P = '01J9ZZZZZZZZZZZZZZZZZZZZZZ';

beforeEach(() => {
  resetModels();
  setMonaco(asMonaco(createFakeMonaco()));
});

describe('D299 one Monaco model per open file', () => {
  it('names each model by project and path, and reads the name back', () => {
    const uri = fileUri(P, 'My Dir/a.ts');
    expect(pathOfUri(uri)).toEqual({ projectId: P, path: 'My Dir/a.ts' });
  });

  it('creates a model once, and reports unsaved changes until the disk holds them', () => {
    const dirty = vi.fn();
    const model = ensureModel(P, 'a.ts', 'one', 'typescript', dirty);
    expect(ensureModel(P, 'a.ts', 'ignored', 'typescript', dirty)).toBe(model);
    model.setValue('two');
    expect(dirty).toHaveBeenLastCalledWith(true);
    markSaved(P, 'a.ts');
    expect(dirty).toHaveBeenLastCalledWith(false);
  });

  it('only the text that was sent counts as saved: typing during a save stays unsaved', () => {
    const dirty = vi.fn();
    const model = ensureModel(P, 'a.ts', 'one', 'plaintext', dirty);
    model.setValue('sent');
    const sent = model.getAlternativeVersionId();
    model.setValue('typed while saving');
    markSaved(P, 'a.ts', sent);
    expect(dirty).toHaveBeenLastCalledWith(true);
  });

  it('replacing the content with the disk’s leaves the buffer clean', () => {
    const dirty = vi.fn();
    ensureModel(P, 'a.ts', 'one', 'plaintext', dirty);
    replaceContent(P, 'a.ts', 'theirs');
    expect(getModel(P, 'a.ts')?.getValue()).toBe('theirs');
    expect(dirty).toHaveBeenLastCalledWith(false);
  });

  it('following the disk never reports dirty, so a preview stays a preview', () => {
    const dirty = vi.fn();
    ensureModel(P, 'a.ts', 'one', 'plaintext', dirty);
    replaceContent(P, 'a.ts', 'theirs');
    expect(dirty).not.toHaveBeenCalledWith(true);
    expect(dirty).toHaveBeenLastCalledWith(false);
  });

  it('a move carries the text and the unsaved state to the new path', () => {
    const model = ensureModel(P, 'src/a.ts', 'one', 'plaintext', () => undefined);
    model.setValue('edited');
    const moved = vi.fn();
    moveModels(
      P,
      'src',
      'lib',
      () => moved,
      () => 'plaintext',
    );
    expect(getModel(P, 'src/a.ts')).toBeUndefined();
    const target = getModel(P, 'lib/a.ts');
    expect(target?.getValue()).toBe('edited');
    target?.setValue('edited more');
    expect(moved).toHaveBeenLastCalledWith(true);
  });
});

describe('[audit F-2] the disk’s text lands as an edit, never a reset', () => {
  it('Take theirs can be undone back to the person’s text, which is unsaved again', () => {
    const dirty = vi.fn();
    const model = ensureModel(P, 'a.ts', 'one', 'plaintext', dirty);
    model.setValue('mine');
    replaceContent(P, 'a.ts', 'theirs');
    expect(model.getValue()).toBe('theirs');
    expect(dirty).toHaveBeenLastCalledWith(false);
    model.undo();
    expect(model.getValue()).toBe('mine');
    expect(dirty).toHaveBeenLastCalledWith(true);
  });

  it('the editor showing the file keeps its cursor and scroll', () => {
    const fake = createFakeMonaco();
    setMonaco(asMonaco(fake));
    const model = ensureModel(P, 'a.ts', 'one\ntwo', 'plaintext', () => undefined);
    const editor = fake.editor.create();
    editor.setModel(model);
    editor.line = 7;
    setActiveEditor(editor as never);
    replaceContent(P, 'a.ts', 'one\ntwo\nthree');
    expect(editor.restoreViewState).toHaveBeenCalledWith({ line: 7 });
  });

  it('takes the disk’s line endings, so the next save writes them', () => {
    const model = ensureModel(P, 'a.ts', 'a\nb', 'plaintext', () => undefined);
    replaceContent(P, 'a.ts', 'a\r\nb\r\nc');
    expect(model.getValue()).toBe('a\r\nb\r\nc');
    expect(model.getEOL()).toBe('\r\n');
  });
});

describe('D299 Phase 4 fix C2: the registry owns its models', () => {
  it('never adopts a model it did not create: that one goes, and the disk’s text shows, clean', () => {
    const fake = createFakeMonaco();
    setMonaco(asMonaco(fake));
    // what Monaco does for go-to-definition: a model from the extra lib's (older) text
    const stray = fake.editor.createModel(
      'export const b = 1;',
      'typescript',
      fileUri(P, 'b.ts') as never,
    );
    const dirty = vi.fn();
    const model = ensureModel(P, 'b.ts', 'export const b = 2;', 'typescript', dirty);
    expect(model).not.toBe(stray);
    expect(stray.isDisposed()).toBe(true);
    expect(model.getValue()).toBe('export const b = 2;');
    expect(dirty).not.toHaveBeenCalledWith(true);
    expect(isRegistryModel(model)).toBe(true);
    expect(isRegistryModel(stray as never)).toBe(false);
  });

  it('says when it opens and closes a file, so the type loader can follow', () => {
    const seen: string[] = [];
    const off = onRegistryChange((projectId, path, open) =>
      seen.push(`${projectId === P ? 'P' : projectId}:${path}:${open ? 'open' : 'closed'}`),
    );
    ensureModel(P, 'a.ts', 'x', 'typescript', () => undefined);
    moveModels(
      P,
      'a.ts',
      'b.ts',
      () => () => undefined,
      () => 'typescript',
    );
    disposeModel(P, 'b.ts');
    off();
    ensureModel(P, 'c.ts', 'x', 'typescript', () => undefined);
    expect(seen).toEqual(['P:a.ts:open', 'P:a.ts:closed', 'P:b.ts:open', 'P:b.ts:closed']);
  });
});
