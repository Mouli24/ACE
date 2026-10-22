import { useLayoutStore } from '../app/stores/layout';
import { useComposerChips, type ChipSource } from '../chat/composer-chips';
import { useEditorStore } from './editor/editor-store';
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

/** Saves one open buffer; true once the disk holds it (the workbench's `saveFile`). */
export type BufferSaver = (projectId: string, path: string) => Promise<boolean>;

let saver: BufferSaver | undefined;

/** The workbench says how a buffer is saved before an agent hears of it; the returned function unregisters it. */
export function setBufferSaver(next: BufferSaver): () => void {
  saver = next;
  return () => {
    if (saver === next) saver = undefined;
  };
}

/**
 * [audit F-1] An agent reads and edits the file on disk, never the editor's buffer: an unsaved
 * buffer is saved first, or the agent works on older text and its edit lands as a conflict. True
 * when the disk holds what the editor shows; false when the save failed or met a conflict.
 */
export async function saveForAgent(
  projectId: string,
  path: string,
  save: BufferSaver | undefined = saver,
): Promise<boolean> {
  if (useEditorStore.getState().projects[projectId]?.files[path]?.dirty !== true) return true;
  return save === undefined ? false : save(projectId, path);
}

/** [audit F-1] The line a hand-over carries when the buffer could not be saved first. */
export const unsavedNote = (path: string): string =>
  `Note: ${path} has unsaved changes in the editor that are not on disk.`;

/** Put a chip in the composer and bring the chat column into view. */
export function askAgentAbout(chip: ChipSource): void {
  useComposerChips.getState().add(chip);
  if (!useLayoutStore.getState().chatOpen) useLayoutStore.getState().toggleChat();
}

/**
 * The chip, once the file's unsaved buffer is saved ([audit F-1]); a save that fails leaves the
 * unsaved note in the message box beside it. A clean file, or no project named, hands over at once.
 */
function handOver(projectId: string | undefined, chip: ChipSource): void {
  const dirty =
    projectId !== undefined &&
    useEditorStore.getState().projects[projectId]?.files[chip.path]?.dirty === true;
  if (!dirty) {
    askAgentAbout(chip);
    return;
  }
  void saveForAgent(projectId, chip.path).then((saved) => {
    if (!saved) useComposerChips.getState().prefill(unsavedNote(chip.path));
    askAgentAbout(chip);
  });
}

/**
 * Ctrl/⌘+L and the editor's "Ask agent": the selection, in `projectId` (whose unsaved buffer is
 * saved first, [audit F-1]). False when no editor is showing a file.
 */
export function askAgentAboutSelection(projectId?: string): boolean {
  const chip = source?.();
  if (chip === undefined) return false;
  handOver(projectId, chip);
  return true;
}

/** The Explorer's "Ask agent about this file": the path, no text — saved first, as above. */
export function askAgentAboutFile(path: string, projectId?: string): void {
  handOver(projectId, { path, language: languageOf(path) });
}
