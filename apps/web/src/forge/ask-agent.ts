import { useLayoutStore } from '../app/stores/layout';
import { useComposerChips, type ChipSource } from '../chat/composer-chips';
import { languageOf } from './editor/languages';

/**
 * Ask agent (D302, design §6.5): Forge hands the chat a reference — a selection, or a whole file —
 * as a chip in the composer, and the chat column comes into view to take it. The chat then talks
 * to its current node. Ctrl/⌘+L and the editor's "Ask agent" read the editor's selection through
 * the source the editor registers here; the Explorer's "Ask agent about this file" and Fix with
 * agent build their chip themselves.
 */

/** Monaco's selection, as far as a chip needs it: 1-based lines and columns, start first. */
export interface SelectionRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

/** The chip for a selection in `value`; an empty selection is the whole file. */
export function selectionChip(path: string, value: string, range: SelectionRange): ChipSource {
  const language = languageOf(path);
  const empty =
    range.startLineNumber === range.endLineNumber && range.startColumn === range.endColumn;
  if (empty) return { path, language };
  // A selection that ends at the very start of a line does not take that line (as VS Code).
  const endLine =
    range.endColumn === 1 && range.endLineNumber > range.startLineNumber
      ? range.endLineNumber - 1
      : range.endLineNumber;
  const endColumn = endLine === range.endLineNumber ? range.endColumn : Number.POSITIVE_INFINITY;
  const lines = value.split(/\r\n|\n/).slice(range.startLineNumber - 1, endLine);
  const lastIndex = lines.length - 1;
  const picked = lines.map((line, index) => {
    const end = index === lastIndex ? line.slice(0, endColumn - 1) : line;
    return index === 0 ? end.slice(range.startColumn - 1) : end;
  });
  const text = picked.join('\n');
  if (text.trim() === '') return { path, language };
  return { path, startLine: range.startLineNumber, endLine, text, language };
}

/** What the editor on screen can say about its selection, or nothing when none is shown. */
export type SelectionSource = () => ChipSource | undefined;

let source: SelectionSource | undefined;

/** The editor registers how to read its selection; the returned function unregisters it. */
export function setSelectionSource(next: SelectionSource): () => void {
  source = next;
  return () => {
    if (source === next) source = undefined;
  };
}

/** Put a chip in the composer and bring the chat column into view. */
export function askAgentAbout(chip: ChipSource): void {
  useComposerChips.getState().add(chip);
  if (!useLayoutStore.getState().chatOpen) useLayoutStore.getState().toggleChat();
}

/** Ctrl/⌘+L and the editor's "Ask agent": the selection. False when no editor is showing a file. */
export function askAgentAboutSelection(): boolean {
  const chip = source?.();
  if (chip === undefined) return false;
  askAgentAbout(chip);
  return true;
}

/** The Explorer's "Ask agent about this file": the path, no text. */
export function askAgentAboutFile(path: string): void {
  askAgentAbout({ path, language: languageOf(path) });
}
