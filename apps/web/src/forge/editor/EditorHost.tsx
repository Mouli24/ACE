import type { TextFileContent } from '@ace/contracts';
import type * as Monaco from 'monaco-editor';
import { useEffect, useRef } from 'react';

import { useResolvedTheme } from '../../app/theme';
import { monaco } from '../../config-panel/monaco-loader';
import { dirtyHandler } from './actions';
import { useEditorStore } from './editor-store';
import { useEditorStatus } from './editor-status';
import { applyForgeTheme } from './forge-theme';
import { languageOf } from './languages';
import { watchMarkers } from '../panel/problems-store';
import { ensureModel, getModel, saveViewState, setMonaco, viewStateOf } from './models';

setMonaco(monaco);
// Problems follows every Forge model's markers from the moment the editor chunk loads (6.4).
watchMarkers(monaco);

export interface EditorHostProps {
  projectId: string;
  path: string;
  /** The disk's text, for a file that has no model yet. */
  initial: TextFileContent | undefined;
}

/**
 * The workbench's one Monaco editor (a lazy chunk). It shows the active file's model and remembers
 * each file's cursor, scroll and folding; the models live in the registry, so switching tabs or
 * modes loses nothing (§2.3).
 */
export function EditorHost({ projectId, path, initial }: EditorHostProps) {
  const container = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  /** The file whose model the editor shows now, so unmounting can save its place first. */
  const shown = useRef<{ projectId: string; path: string } | null>(null);
  const theme = useResolvedTheme();
  const reveal = useEditorStore((state) => state.projects[projectId]?.reveal);

  useEffect(() => applyForgeTheme(monaco, theme), [theme]);

  useEffect(() => {
    if (container.current === null) return;
    const editor = monaco.editor.create(container.current, {
      model: null,
      automaticLayout: true,
      fontFamily: "'JetBrains Mono Variable', 'JetBrains Mono', Consolas, monospace",
      fontSize: 13,
      lineHeight: 20,
      minimap: { enabled: true, renderCharacters: false },
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      renderWhitespace: 'selection',
      bracketPairColorization: { enabled: true },
      fixedOverflowWidgets: true,
      tabSize: 2,
    });
    editorRef.current = editor;
    const cursor = editor.onDidChangeCursorPosition((event) =>
      useEditorStatus.getState().setCursor(event.position.lineNumber, event.position.column),
    );
    return () => {
      // Before dispose: a disposed editor has detached its model and has no view state to give.
      if (shown.current !== null) {
        saveViewState(shown.current.projectId, shown.current.path, editor.saveViewState());
      }
      cursor.dispose();
      editor.dispose();
      editorRef.current = null;
    };
  }, []);

  // Show this file's model; give the previous one's place back to the registry on the way out.
  // `initial` is read once: later disk changes reach the model through useEditorSync (§5.4).
  useEffect(() => {
    const editor = editorRef.current;
    if (editor === null) return;
    const model =
      getModel(projectId, path) ??
      (initial
        ? ensureModel(
            projectId,
            path,
            initial.content,
            languageOf(path),
            dirtyHandler(projectId, path),
          )
        : undefined);
    if (model === undefined) {
      shown.current = null;
      return;
    }
    const before = useEditorStore.getState().projects[projectId]?.files[path];
    if (initial && before?.baseVersion === undefined)
      useEditorStore.getState().loaded(projectId, path, initial.version, initial.bom);
    editor.setModel(model);
    shown.current = { projectId, path };
    const view = viewStateOf(projectId, path);
    if (view !== null) editor.restoreViewState(view);
    editor.focus();
    // Read after loaded(): the store's default bom is false, so a render-time value would hide the
    // BOM of the content just loaded.
    const loadedBom = useEditorStore.getState().projects[projectId]?.files[path]?.bom ?? false;
    useEditorStatus.getState().describe(model, loadedBom);
    const position = editor.getPosition();
    if (position) useEditorStatus.getState().setCursor(position.lineNumber, position.column);
    return () => {
      // On a path change the editor is alive; on unmount the creation cleanup has already saved.
      saveViewState(projectId, path, editor.saveViewState());
    };
    // `initial` only seeds a new model (see above), so it is not a dependency.
  }, [projectId, path]);

  useEffect(() => {
    const editor = editorRef.current;
    if (editor === null || reveal === undefined || reveal.path !== path) return;
    editor.revealLineInCenter(reveal.line);
    editor.setPosition({ lineNumber: reveal.line, column: reveal.column });
    editor.focus();
    useEditorStore.getState().revealDone(projectId);
  }, [reveal, path, projectId]);

  return <div ref={container} className="h-full w-full" data-testid="monaco-host" />;
}
