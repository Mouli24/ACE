import { beforeEach, describe, expect, it, vi } from 'vitest';

import { asMonaco, createFakeMonaco } from '../../test/fake-monaco';
import {
  ensureModel,
  fileUri,
  getModel,
  markSaved,
  moveModels,
  pathOfUri,
  replaceContent,
  resetModels,
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
