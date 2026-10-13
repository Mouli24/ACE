import { chipLabel, chipPart, useComposerChips } from './composer-chips';

/*
 * D302 Ask agent: the editor and the Explorer add reference chips to the chat composer; each chip
 * is sent as a `code` part carrying its path and lines.
 */

beforeEach(() => useComposerChips.getState().reset());

describe('D302 composer chips', () => {
  it('labels a selection path:Lstart-Lend, one line path:Ln, a whole file by its path', () => {
    expect(chipLabel({ path: 'src/a.ts', startLine: 3, endLine: 7, language: 'ts' })).toBe(
      'src/a.ts:L3-L7',
    );
    expect(chipLabel({ path: 'src/a.ts', startLine: 3, endLine: 3, language: 'ts' })).toBe(
      'src/a.ts:L3',
    );
    expect(chipLabel({ path: 'README.md', language: 'markdown' })).toBe('README.md');
  });

  it('becomes a code part with the path and lines, and no text for a whole file', () => {
    expect(
      chipPart({
        path: 'src/a.ts',
        startLine: 3,
        endLine: 4,
        text: 'const a = 1;\nconst b = 2;',
        language: 'typescript',
      }),
    ).toEqual({
      type: 'code',
      language: 'typescript',
      text: 'const a = 1;\nconst b = 2;',
      path: 'src/a.ts',
      startLine: 3,
      endLine: 4,
    });
    expect(chipPart({ path: 'README.md', language: 'markdown' })).toEqual({
      type: 'code',
      language: 'markdown',
      text: '',
      path: 'README.md',
    });
  });

  it('adds a chip once, removes one, and clears all', () => {
    const { add } = useComposerChips.getState();
    add({ path: 'src/a.ts', startLine: 1, endLine: 2, text: 'x', language: 'typescript' });
    add({ path: 'src/a.ts', startLine: 1, endLine: 2, text: 'x', language: 'typescript' });
    add({ path: 'README.md', language: 'markdown' });
    const chips = useComposerChips.getState().chips;
    expect(chips.map(chipLabel)).toEqual(['src/a.ts:L1-L2', 'README.md']);

    useComposerChips.getState().remove(chips[0]!.id);
    expect(useComposerChips.getState().chips.map(chipLabel)).toEqual(['README.md']);
    useComposerChips.getState().clear();
    expect(useComposerChips.getState().chips).toEqual([]);
  });

  it('holds a draft for the composer to take once', () => {
    useComposerChips.getState().prefill('Fix this problem: x');
    expect(useComposerChips.getState().takeDraft()).toBe('Fix this problem: x');
    expect(useComposerChips.getState().takeDraft()).toBeUndefined();
  });
});
