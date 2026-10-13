import { useLayoutStore } from '../app/stores/layout';
import { useComposerChips } from '../chat/composer-chips';
import {
  askAgentAboutFile,
  askAgentAboutSelection,
  selectionChip,
  setSelectionSource,
} from './ask-agent';

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
