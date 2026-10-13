import type { Part } from '@ace/contracts';
import { create } from 'zustand';

/**
 * The chat composer's reference chips (D302, design §6.5). Forge adds them — Ask agent on a
 * selection (Ctrl/⌘+L or the editor's menu), Ask agent about this file in the Explorer, and Fix
 * with agent when no node is selected — and the composer shows them above the box and sends each
 * as a `code` part with its path and lines. A store, because the editor and the chat column are
 * different trees: the chip has to be there when the composer looks.
 */

export interface ChipSource {
  /** Project-relative, forward slashes. */
  path: string;
  /** 1-based, inclusive. Absent for a whole-file chip. */
  startLine?: number;
  endLine?: number;
  /** The selected text. Absent for a whole-file chip: the path is the reference. */
  text?: string;
  /** Monaco's language id for the file. */
  language: string;
}

export interface ComposerChip extends ChipSource {
  id: string;
}

/** `src/a.ts:L3-L7`, `src/a.ts:L3`, or `src/a.ts` for a whole file. */
export function chipLabel(chip: ChipSource): string {
  if (chip.startLine === undefined) return chip.path;
  const end =
    chip.endLine === undefined || chip.endLine === chip.startLine ? '' : `-L${chip.endLine}`;
  return `${chip.path}:L${chip.startLine}${end}`;
}

/** The `code` part a chip is sent as. */
export function chipPart(chip: ChipSource): Part {
  return {
    type: 'code',
    language: chip.language,
    text: chip.text ?? '',
    path: chip.path,
    ...(chip.startLine === undefined ? {} : { startLine: chip.startLine }),
    ...(chip.endLine === undefined ? {} : { endLine: chip.endLine }),
  };
}

interface ComposerChipsState {
  chips: ComposerChip[];
  /** Text for the composer's box, taken once (Fix with agent with no node selected). */
  draft: string | undefined;
  /** The project the chips and the draft were made in (fix B-M7). */
  projectId: string | undefined;
  /** Add a chip; one with the same place is already there, so it is not added twice. */
  add(chip: ChipSource): void;
  remove(id: string): void;
  clear(): void;
  prefill(text: string): void;
  /** The draft, once: the composer takes it and it is gone. */
  takeDraft(): string | undefined;
  /**
   * The workspace shows this project now (fix B-M7): chips and a draft made in another project go,
   * so another project's paths and code are never sent to this one's nodes.
   */
  enterProject(projectId: string): void;
  /** Tests only. */
  reset(): void;
}

let seq = 0;

export const useComposerChips = create<ComposerChipsState>()((set, get) => ({
  chips: [],
  draft: undefined,
  projectId: undefined,
  add: (chip) =>
    set((state) =>
      state.chips.some((each) => chipLabel(each) === chipLabel(chip) && each.text === chip.text)
        ? state
        : { chips: [...state.chips, { ...chip, id: `chip-${(seq += 1)}` }] },
    ),
  remove: (id) => set((state) => ({ chips: state.chips.filter((chip) => chip.id !== id) })),
  clear: () => set({ chips: [] }),
  prefill: (draft) => set({ draft }),
  takeDraft: () => {
    const { draft } = get();
    if (draft !== undefined) set({ draft: undefined });
    return draft;
  },
  enterProject: (projectId) =>
    set((state) =>
      state.projectId === projectId ? state : { chips: [], draft: undefined, projectId },
    ),
  reset: () => set({ chips: [], draft: undefined, projectId: undefined }),
}));
