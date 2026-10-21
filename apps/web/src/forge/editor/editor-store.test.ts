import { beforeEach, describe, expect, it } from 'vitest';

import { hasUnsavedWork, useEditorStore } from './editor-store';

const P = 'p1';
const store = () => useEditorStore.getState();
const editor = () => store().projects[P];

beforeEach(() => useEditorStore.setState({ projects: {} }));

describe('[audit F-13] a deleted project is forgotten', () => {
  it('its tabs and unsaved buffers go, so nothing is left to ask about; other projects stay', () => {
    store().open(P, 'a.ts');
    store().setDirty(P, 'a.ts', true);
    store().open('p2', 'b.ts');
    expect(hasUnsavedWork(store())).toBe(true);
    store().forget(P);
    expect(editor()).toBeUndefined();
    expect(hasUnsavedWork(store())).toBe(false);
    expect(store().projects['p2']?.tabs).toEqual(['b.ts']);
  });
});

describe('D299 FR-GIT-004 the editor’s tabs', () => {
  it('a preview open replaces the previous preview; a pinned open stays', () => {
    store().open(P, 'a.ts', { preview: true });
    store().open(P, 'b.ts', { preview: true });
    expect(editor()?.tabs).toEqual(['b.ts']);
    expect(editor()?.preview).toBe('b.ts');
    store().open(P, 'b.ts');
    expect(editor()?.preview).toBeUndefined();
    store().open(P, 'c.ts', { preview: true });
    expect(editor()?.tabs).toEqual(['b.ts', 'c.ts']);
  });

  it('a preview with unsaved changes is pinned, never replaced', () => {
    store().open(P, 'a.ts', { preview: true });
    store().setDirty(P, 'a.ts', true);
    expect(editor()?.preview).toBeUndefined();
    store().open(P, 'b.ts', { preview: true });
    expect(editor()?.tabs).toEqual(['a.ts', 'b.ts']);
  });

  it('opens next to the active tab, and closing activates the right neighbour, else the left', () => {
    store().open(P, 'a.ts');
    store().open(P, 'b.ts');
    store().activate(P, 'a.ts');
    store().open(P, 'c.ts');
    expect(editor()?.tabs).toEqual(['a.ts', 'c.ts', 'b.ts']);
    store().closeMany(P, ['c.ts']);
    expect(editor()?.active).toBe('b.ts');
    store().closeMany(P, ['b.ts']);
    expect(editor()?.active).toBe('a.ts');
  });

  it('a moved folder takes its open files with it, unsaved state and all', () => {
    store().open(P, 'src/a.ts');
    store().open(P, 'src/deep/b.ts');
    store().setDirty(P, 'src/deep/b.ts', true);
    store().renamed(P, 'src', 'lib');
    expect(editor()?.tabs).toEqual(['lib/a.ts', 'lib/deep/b.ts']);
    expect(editor()?.files['lib/deep/b.ts']).toMatchObject({ path: 'lib/deep/b.ts', dirty: true });
    expect(editor()?.active).toBe('lib/deep/b.ts');
  });

  it('knows when any project holds unsaved work', () => {
    store().open(P, 'a.ts');
    expect(hasUnsavedWork(store())).toBe(false);
    store().setDirty(P, 'a.ts', true);
    expect(hasUnsavedWork(store())).toBe(true);
  });
});
