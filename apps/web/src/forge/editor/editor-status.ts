import { create } from 'zustand';

interface DescribedModel {
  getLanguageId(): string;
  getEOL(): string;
  getOptions(): { insertSpaces: boolean; tabSize: number };
}

interface EditorStatusState {
  line: number;
  column: number;
  language: string;
  eol: 'LF' | 'CRLF';
  indentation: string;
  bom: boolean;
  setCursor(line: number, column: number): void;
  describe(model: DescribedModel, bom: boolean): void;
}

/** What the status bar reads about the active editor (Task 18). */
export const useEditorStatus = create<EditorStatusState>()((set) => ({
  line: 1,
  column: 1,
  language: 'plaintext',
  eol: 'LF',
  indentation: 'Spaces: 2',
  bom: false,
  setCursor: (line, column) => set({ line, column }),
  describe: (model, bom) => {
    const options = model.getOptions();
    set({
      language: model.getLanguageId(),
      eol: model.getEOL() === '\r\n' ? 'CRLF' : 'LF',
      indentation: options.insertSpaces
        ? `Spaces: ${options.tabSize}`
        : `Tab Size: ${options.tabSize}`,
      bom,
    });
  },
}));
