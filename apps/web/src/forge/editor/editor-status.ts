import { create } from 'zustand';

interface DescribedModel {
  getLanguageId(): string;
  getEOL(): string;
  getOptions(): { insertSpaces: boolean; tabSize: number };
}

interface EditorStatusState {
  /**
   * The text file the Forge editor shows, or `null` when it shows none: no file is open, the active
   * one is an image or a notice, a conflict is being compared, or Forge is not mounted. The
   * workspace footer hides its `Ln, Col · Language` while this is `null` (D330).
   */
  path: string | null;
  line: number;
  column: number;
  language: string;
  eol: 'LF' | 'CRLF';
  indentation: string;
  bom: boolean;
  setCursor(line: number, column: number): void;
  describe(path: string, model: DescribedModel, bom: boolean): void;
  /** No text file in the editor any more. */
  clear(): void;
}

const IDLE = {
  path: null,
  line: 1,
  column: 1,
  language: 'plaintext',
  eol: 'LF',
  indentation: 'Spaces: 2',
  bom: false,
} as const;

/** What the workspace footer reads about the active editor (D330). */
export const useEditorStatus = create<EditorStatusState>()((set) => ({
  ...IDLE,
  setCursor: (line, column) => set({ line, column }),
  describe: (path, model, bom) => {
    const options = model.getOptions();
    set({
      path,
      language: model.getLanguageId(),
      eol: model.getEOL() === '\r\n' ? 'CRLF' : 'LF',
      indentation: options.insertSpaces
        ? `Spaces: ${options.tabSize}`
        : `Tab Size: ${options.tabSize}`,
      bom,
    });
  },
  clear: () => set(IDLE),
}));
