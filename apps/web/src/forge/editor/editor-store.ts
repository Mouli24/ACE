import { create } from 'zustand';

import { useReviewStore } from '../changes/review-store';
import { isWithin, movedPath } from '../files/paths';

export type Conflict = 'changed' | 'deleted';

export interface OpenFile {
  path: string;
  /**
   * The disk version the buffer was loaded from or last saved as. `null`: not on disk (deleted
   * since, so a save recreates it). `undefined`: the content has not loaded yet.
   */
  baseVersion: string | null | undefined;
  bom: boolean;
  dirty: boolean;
  saving: boolean;
  /** The disk moved on under an unsaved buffer (design §5.4). */
  conflict: Conflict | undefined;
  /** Gone from disk while the buffer was clean: struck through until it is closed or saved. */
  deletedOnDisk: boolean;
  /**
   * [audit F-5] The disk's file is no longer text Forge opens — binary now, or over 2 MB: the
   * buffer stays, a bar says so, and a save never writes over it.
   */
  notText?: 'binary' | 'too_large' | undefined;
  /** The last save's failure, in words (design §10). */
  error: string | undefined;
}

export interface Reveal {
  path: string;
  line: number;
  column: number;
}

export interface ProjectEditor {
  tabs: string[];
  active: string | undefined;
  /** The italic preview tab a single click opened; the next preview replaces it (§6.2). */
  preview: string | undefined;
  files: Record<string, OpenFile>;
  /** A position to show once the file is in the editor (Problems). */
  reveal: Reveal | undefined;
}

export const EMPTY_EDITOR: ProjectEditor = {
  tabs: [],
  active: undefined,
  preview: undefined,
  files: {},
  reveal: undefined,
};

const fresh = (path: string): OpenFile => ({
  path,
  baseVersion: undefined,
  bom: false,
  dirty: false,
  saving: false,
  conflict: undefined,
  deletedOnDisk: false,
  error: undefined,
});

/** The preview tab a new preview of `path` would replace: the current one, unless it holds unsaved work. */
export function replaceablePreview(editor: ProjectEditor, path: string): string | undefined {
  const { preview } = editor;
  return preview !== undefined && preview !== path && editor.files[preview]?.dirty !== true
    ? preview
    : undefined;
}

interface EditorState {
  projects: Record<string, ProjectEditor>;
  open(projectId: string, path: string, options?: { preview?: boolean }): void;
  activate(projectId: string, path: string): void;
  pin(projectId: string, path: string): void;
  closeMany(projectId: string, paths: readonly string[]): void;
  loaded(projectId: string, path: string, version: string, bom: boolean): void;
  setDirty(projectId: string, path: string, dirty: boolean): void;
  saveStarted(projectId: string, path: string): void;
  saved(projectId: string, path: string, version: string): void;
  saveFailed(projectId: string, path: string, message: string): void;
  conflicted(projectId: string, path: string, conflict: Conflict): void;
  /** Buffer and disk agree again (a reload, Keep mine, Take theirs): a new base, no conflict. */
  resolved(projectId: string, path: string, baseVersion: string | null): void;
  markDeletedOnDisk(projectId: string, path: string): void;
  /** [audit F-5] The disk holds the file as binary or too large now; `undefined`: text again. */
  markNotText(projectId: string, path: string, kind: OpenFile['notText']): void;
  renamed(projectId: string, from: string, to: string): void;
  /** Show a place in a file; a review showing gives the editor area back (fix F-M2). */
  revealAt(projectId: string, reveal: Reveal): void;
  revealDone(projectId: string): void;
}

/**
 * Forge's editor workspace per project, outside every component, so a mode switch, a workflow
 * switch or a route change never tears it down (D299, design §2.3). The Monaco models themselves
 * live in `models.ts`; this holds what React renders.
 */
export const useEditorStore = create<EditorState>()((set) => {
  const update = (projectId: string, change: (editor: ProjectEditor) => ProjectEditor) =>
    set((state) => ({
      projects: {
        ...state.projects,
        [projectId]: change(state.projects[projectId] ?? EMPTY_EDITOR),
      },
    }));
  const patch = (projectId: string, path: string, fields: Partial<OpenFile>) =>
    update(projectId, (editor) => {
      const file = editor.files[path];
      return file === undefined
        ? editor
        : { ...editor, files: { ...editor.files, [path]: { ...file, ...fields } } };
    });

  return {
    projects: {},

    open: (projectId, path, options = {}) =>
      update(projectId, (editor) => {
        const preview = options.preview === true;
        if (editor.files[path] !== undefined) {
          return {
            ...editor,
            active: path,
            preview: !preview && editor.preview === path ? undefined : editor.preview,
          };
        }
        const replaced = preview ? replaceablePreview(editor, path) : undefined;
        const files: Record<string, OpenFile> = { ...editor.files, [path]: fresh(path) };
        let tabs: string[];
        if (replaced !== undefined) {
          delete files[replaced];
          tabs = editor.tabs.map((tab) => (tab === replaced ? path : tab));
        } else {
          const at =
            editor.active === undefined
              ? editor.tabs.length
              : editor.tabs.indexOf(editor.active) + 1;
          tabs = [...editor.tabs.slice(0, at), path, ...editor.tabs.slice(at)];
        }
        return { ...editor, tabs, files, active: path, preview: preview ? path : editor.preview };
      }),

    activate: (projectId, path) =>
      update(projectId, (editor) => (editor.files[path] ? { ...editor, active: path } : editor)),

    pin: (projectId, path) =>
      update(projectId, (editor) =>
        editor.preview === path ? { ...editor, preview: undefined } : editor,
      ),

    closeMany: (projectId, paths) =>
      update(projectId, (editor) => {
        const closing = new Set(paths);
        const tabs = editor.tabs.filter((tab) => !closing.has(tab));
        const files = Object.fromEntries(
          Object.entries(editor.files).filter(([path]) => !closing.has(path)),
        );
        let { active } = editor;
        if (active !== undefined && closing.has(active)) {
          const index = editor.tabs.indexOf(active);
          active =
            editor.tabs.slice(index + 1).find((tab) => !closing.has(tab)) ??
            editor.tabs
              .slice(0, index)
              .reverse()
              .find((tab) => !closing.has(tab));
        }
        const preview =
          editor.preview !== undefined && closing.has(editor.preview) ? undefined : editor.preview;
        return { ...editor, tabs, files, active, preview };
      }),

    loaded: (projectId, path, version, bom) =>
      patch(projectId, path, { baseVersion: version, bom }),

    setDirty: (projectId, path, dirty) =>
      update(projectId, (editor) => {
        const file = editor.files[path];
        if (file === undefined || file.dirty === dirty) return editor;
        return {
          ...editor,
          files: { ...editor.files, [path]: { ...file, dirty } },
          // editing a preview keeps it (§6.2)
          preview: dirty && editor.preview === path ? undefined : editor.preview,
        };
      }),

    saveStarted: (projectId, path) => patch(projectId, path, { saving: true, error: undefined }),
    saved: (projectId, path, version) =>
      patch(projectId, path, {
        saving: false,
        baseVersion: version,
        deletedOnDisk: false,
        error: undefined,
      }),
    saveFailed: (projectId, path, message) =>
      patch(projectId, path, { saving: false, error: message }),
    conflicted: (projectId, path, conflict) => patch(projectId, path, { saving: false, conflict }),
    resolved: (projectId, path, baseVersion) =>
      patch(projectId, path, { baseVersion, conflict: undefined, deletedOnDisk: false }),
    markDeletedOnDisk: (projectId, path) =>
      patch(projectId, path, { deletedOnDisk: true, baseVersion: null }),
    markNotText: (projectId, path, kind) => patch(projectId, path, { notText: kind }),

    renamed: (projectId, from, to) =>
      update(projectId, (editor) => {
        const move = (path: string): string =>
          isWithin(path, from) ? movedPath(path, from, to) : path;
        return {
          tabs: editor.tabs.map(move),
          files: Object.fromEntries(
            Object.entries(editor.files).map(([path, file]) => [
              move(path),
              isWithin(path, from)
                ? // A save begun during the move answers for the old path and never clears these,
                  // so they start over here; the unsaved mark stays, to save at the new path
                  // (review minor 2).
                  { ...file, path: move(path), saving: false, error: undefined }
                : file,
            ]),
          ),
          active: editor.active === undefined ? undefined : move(editor.active),
          preview: editor.preview === undefined ? undefined : move(editor.preview),
          reveal:
            editor.reveal === undefined
              ? undefined
              : { ...editor.reveal, path: move(editor.reveal.path) },
        };
      }),

    revealAt: (projectId, reveal) => {
      // the editor host that takes the reveal shows only while no review does
      useReviewStore.getState().deactivate(projectId);
      update(projectId, (editor) => ({ ...editor, reveal }));
    },
    revealDone: (projectId) => update(projectId, (editor) => ({ ...editor, reveal: undefined })),
  };
});

export const useProjectEditor = (projectId: string): ProjectEditor =>
  useEditorStore((state) => state.projects[projectId] ?? EMPTY_EDITOR);

export const useOpenFile = (projectId: string, path: string | undefined): OpenFile | undefined =>
  useEditorStore((state) =>
    path === undefined ? undefined : state.projects[projectId]?.files[path],
  );

/**
 * What Save all saves, and what enables its button (review I1): an unsaved buffer that is not in
 * conflict. A clean tab is never written — even one deleted on disk, which Save all would bring
 * back; that stays the Deleted bar's explicit choice. A conflict is the conflict bar's to resolve.
 */
export const needsSaveAll = (file: OpenFile): boolean => file.dirty && file.conflict === undefined;

export const hasUnsavedWork = (state: Pick<EditorState, 'projects'>): boolean =>
  Object.values(state.projects).some((editor) =>
    Object.values(editor.files).some((file) => file.dirty),
  );
