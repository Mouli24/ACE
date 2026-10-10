import type * as Monaco from 'monaco-editor';

import { isWithin, movedPath } from '../files/paths';

type MonacoApi = typeof Monaco;
type Model = Monaco.editor.ITextModel;

interface Entry {
  model: Model;
  /** The alternative version id the disk holds; any other is unsaved (undo back to it is clean, as in VS Code). */
  savedAlt: number;
  viewState: Monaco.editor.ICodeEditorViewState | null;
  onDirty: (dirty: boolean) => void;
  listener: Monaco.IDisposable;
}

let monaco: MonacoApi | undefined;
const entries = new Map<string, Entry>();
const keyOf = (projectId: string, path: string): string => `${projectId}\u0000${path}`;

/**
 * Forge's Monaco models (D299, §6.2): one per open file, outliving the editor widget, so tabs, modes
 * and workflows can switch without losing text, undo, cursor or scroll. Monaco itself is set by the
 * lazy editor chunk (`setMonaco`); tests set a fake.
 */
export function setMonaco(instance: MonacoApi): void {
  monaco = instance;
}

/** `file:///<projectId>/<path>`: one URI space per project, so two projects' `src/index.ts` never share a model. */
export function fileUri(projectId: string, path: string): Monaco.Uri {
  if (monaco === undefined) throw new Error('Monaco is not loaded yet.');
  return monaco.Uri.from({ scheme: 'file', path: `/${projectId}/${path}` });
}

/** The project and path a model's URI names — how a Problems marker finds its file. */
export function pathOfUri(uri: Monaco.Uri): { projectId: string; path: string } | undefined {
  if (uri.scheme !== 'file') return undefined;
  const [, projectId, ...rest] = uri.path.split('/');
  return projectId === undefined || projectId === '' || rest.length === 0
    ? undefined
    : { projectId, path: rest.join('/') };
}

export function getModel(projectId: string, path: string): Model | undefined {
  const entry = entries.get(keyOf(projectId, path));
  return entry === undefined || entry.model.isDisposed() ? undefined : entry.model;
}

export function ensureModel(
  projectId: string,
  path: string,
  content: string,
  language: string,
  onDirty: (dirty: boolean) => void,
): Model {
  const key = keyOf(projectId, path);
  const existing = entries.get(key);
  if (existing !== undefined && !existing.model.isDisposed()) return existing.model;
  if (monaco === undefined) throw new Error('Monaco is not loaded yet.');
  const uri = fileUri(projectId, path);
  const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(content, language, uri);
  const entry: Entry = {
    model,
    savedAlt: model.getAlternativeVersionId(),
    viewState: null,
    onDirty,
    listener: model.onDidChangeContent(() =>
      entry.onDirty(model.getAlternativeVersionId() !== entry.savedAlt),
    ),
  };
  entries.set(key, entry);
  return model;
}

/**
 * The disk now holds this buffer — all of it, or (`alt`) the text as it was when a save started,
 * so typing during the save stays unsaved.
 */
export function markSaved(projectId: string, path: string, alt?: number): void {
  const entry = entries.get(keyOf(projectId, path));
  if (entry === undefined) return;
  entry.savedAlt = alt ?? entry.model.getAlternativeVersionId();
  entry.onDirty(entry.model.getAlternativeVersionId() !== entry.savedAlt);
}

/** The buffer takes the disk's text (a clean buffer following the disk, or Take theirs); it is clean after. */
export function replaceContent(projectId: string, path: string, content: string): void {
  const entry = entries.get(keyOf(projectId, path));
  if (entry === undefined) return;
  if (entry.model.getValue() !== content) entry.model.setValue(content);
  markSaved(projectId, path);
}

export function saveViewState(
  projectId: string,
  path: string,
  viewState: Monaco.editor.ICodeEditorViewState | null,
): void {
  const entry = entries.get(keyOf(projectId, path));
  // A null is Monaco having nothing to give (a disposed editor), never a reason to forget a place.
  if (entry !== undefined && viewState !== null) entry.viewState = viewState;
}

export function viewStateOf(
  projectId: string,
  path: string,
): Monaco.editor.ICodeEditorViewState | null {
  return entries.get(keyOf(projectId, path))?.viewState ?? null;
}

/** A file or folder moved: its models move to the new URIs with their text, unsaved state and place. */
export function moveModels(
  projectId: string,
  from: string,
  to: string,
  onDirtyFor: (path: string) => (dirty: boolean) => void,
  languageOf: (path: string) => string,
): void {
  for (const [key, entry] of [...entries]) {
    const [owner, path = ''] = key.split('\u0000');
    if (owner !== projectId || !isWithin(path, from)) continue;
    const target = movedPath(path, from, to);
    const dirty = entry.model.getAlternativeVersionId() !== entry.savedAlt;
    const value = entry.model.getValue();
    entry.listener.dispose();
    if (!entry.model.isDisposed()) entry.model.dispose();
    entries.delete(key);
    ensureModel(projectId, target, value, languageOf(target), onDirtyFor(target));
    const moved = entries.get(keyOf(projectId, target));
    if (moved !== undefined) {
      moved.viewState = entry.viewState;
      if (dirty) moved.savedAlt = -1;
    }
  }
}

export function disposeModel(projectId: string, path: string): void {
  const key = keyOf(projectId, path);
  const entry = entries.get(key);
  if (entry === undefined) return;
  entry.listener.dispose();
  if (!entry.model.isDisposed()) entry.model.dispose();
  entries.delete(key);
}

/** Tests only. */
export function resetModels(): void {
  for (const entry of entries.values()) {
    entry.listener.dispose();
    if (!entry.model.isDisposed()) entry.model.dispose();
  }
  entries.clear();
  monaco = undefined;
}
