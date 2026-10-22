import { waitFor } from '@testing-library/react';

import { useLayoutStore } from '../app/stores/layout';
import { useComposerChips } from '../chat/composer-chips';
import {
  askAgentAboutFile,
  askAgentAboutSelection,
  selectionChip,
  setBufferSaver,
  setSelectionSource,
} from './ask-agent';
import { useEditorStore } from './editor/editor-store';

/*
 * D302 Ask agent (design §6.5): a selection in the editor, or a whole file from the Explorer,
 * becomes a reference chip in the chat composer.
 */

const FILE = ['import a from "a";', '', 'export function sum(x, y) {', '  return x + y;', '}'].join(
  '\n',
);

beforeEach(() => {
  useComposerChips.getState().reset();
  useLayoutStore.setState({ chatOpen: false });
});

describe('D302 selectionChip', () => {
  it('takes the selected text and its lines', () => {
    expect(
      selectionChip('src/sum.ts', FILE, {
        startLineNumber: 3,
        startColumn: 1,
        endLineNumber: 4,
        endColumn: 16,
      }),
    ).toEqual({
      path: 'src/sum.ts',
      startLine: 3,
      endLine: 4,
      text: 'export function sum(x, y) {\n  return x + y;',
      language: 'typescript',
    });
  });

  it('cuts a selection inside one line, and drops a last line selected only up to its start', () => {
    expect(
      selectionChip('src/sum.ts', FILE, {
        startLineNumber: 4,
        startColumn: 10,
        endLineNumber: 4,
        endColumn: 15,
      }),
    ).toMatchObject({ startLine: 4, endLine: 4, text: 'x + y' });
    expect(
      selectionChip('src/sum.ts', FILE, {
        startLineNumber: 3,
        startColumn: 1,
        endLineNumber: 5,
        endColumn: 1,
      }),
    ).toMatchObject({
      startLine: 3,
      endLine: 4,
      text: 'export function sum(x, y) {\n  return x + y;',
    });
  });

  it('is the whole file when nothing is selected', () => {
    expect(
      selectionChip('src/sum.ts', FILE, {
        startLineNumber: 2,
        startColumn: 1,
        endLineNumber: 2,
        endColumn: 1,
      }),
    ).toEqual({ path: 'src/sum.ts', language: 'typescript' });
  });
});

describe('D302 asking the agent', () => {
  it('adds the editor’s selection as a chip and opens the chat', () => {
    const stop = setSelectionSource(() =>
      selectionChip('src/sum.ts', FILE, {
        startLineNumber: 4,
        startColumn: 1,
        endLineNumber: 4,
        endColumn: 16,
      }),
    );
    expect(askAgentAboutSelection()).toBe(true);
    expect(useComposerChips.getState().chips).toMatchObject([
      { path: 'src/sum.ts', startLine: 4, endLine: 4, text: '  return x + y;' },
    ]);
    expect(useLayoutStore.getState().chatOpen).toBe(true);
    stop();
    expect(askAgentAboutSelection()).toBe(false);
  });

  it('adds a file by its path alone', () => {
    askAgentAboutFile('README.md');
    expect(useComposerChips.getState().chips).toMatchObject([
      { path: 'README.md', language: 'markdown' },
    ]);
    expect(useComposerChips.getState().chips[0]).not.toHaveProperty('text');
  });
});

describe('[audit F-1] Ask agent saves an unsaved buffer before the agent reads the file', () => {
  const P = '01J9ZZZZZZZZZZZZZZZZZZZZZZ';
  const select = () =>
    setSelectionSource(() =>
      selectionChip('src/sum.ts', FILE, {
        startLineNumber: 4,
        startColumn: 1,
        endLineNumber: 4,
        endColumn: 16,
      }),
    );

  beforeEach(() => {
    useEditorStore.setState({ projects: {} });
    useEditorStore.getState().open(P, 'src/sum.ts');
  });

  it('saves the file first, then adds the chip', async () => {
    useEditorStore.getState().setDirty(P, 'src/sum.ts', true);
    const save = vi.fn(() => Promise.resolve(true));
    const unregister = setBufferSaver(save);
    const stop = select();

    expect(askAgentAboutSelection(P)).toBe(true);
    expect(save).toHaveBeenCalledWith(P, 'src/sum.ts');
    await waitFor(() =>
      expect(useComposerChips.getState().chips).toMatchObject([
        { path: 'src/sum.ts', startLine: 4, text: '  return x + y;' },
      ]),
    );
    expect(useComposerChips.getState().draft).toBeUndefined();
    stop();
    unregister();
  });

  it('a save that fails still adds the chip, with a line saying the file is unsaved', async () => {
    useEditorStore.getState().setDirty(P, 'src/sum.ts', true);
    const unregister = setBufferSaver(() => Promise.resolve(false));

    askAgentAboutFile('src/sum.ts', P);
    await waitFor(() =>
      expect(useComposerChips.getState().chips).toMatchObject([{ path: 'src/sum.ts' }]),
    );
    expect(useComposerChips.getState().draft).toBe(
      'Note: src/sum.ts has unsaved changes in the editor that are not on disk.',
    );
    unregister();
  });

  it('a file with nothing unsaved goes at once, and is not saved', () => {
    const save = vi.fn(() => Promise.resolve(true));
    const unregister = setBufferSaver(save);

    askAgentAboutFile('src/sum.ts', P);
    expect(useComposerChips.getState().chips).toMatchObject([{ path: 'src/sum.ts' }]);
    expect(save).not.toHaveBeenCalled();
    unregister();
  });
});
