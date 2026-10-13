import type { TextFileContent } from '@ace/contracts';
import type * as Monaco from 'monaco-editor';
import { useEffect, useRef } from 'react';

import { useResolvedTheme } from '../../app/theme';
import { monaco } from '../../config-panel/monaco-loader';
import { AGENT_COLORS } from '../../theme/constants';
import { touchedLines, type FileTouch } from '../attribution';
import { dirtyHandler } from './actions';
import { useEditorStore } from './editor-store';
import { useEditorStatus } from './editor-status';
import { applyForgeTheme } from './forge-theme';
import { configureLanguageDefaults } from './language-defaults';
import { languageOf } from './languages';
import { watchMarkers } from '../panel/problems-store';
import {
  ensureModel,
  getModel,
  saveViewState,
  setActiveEditor,
  setMonaco,
  viewStateOf,
} from './models';

setMonaco(monaco);
// TS/JS and JSON set for real projects before the first model exists (review I3).
configureLanguageDefaults(monaco);
// Problems follows every Forge model's markers from the moment the editor chunk loads (6.4).
watchMarkers(monaco);

export interface EditorHostProps {
  projectId: string;
  path: string;
  /** The disk's text, for a file that has no model yet. */
  initial: TextFileContent | undefined;
  /** The run's latest write to this file, drawn as a bar in the agent's colour (D334). */
  touch?: FileTouch | undefined;
}

/** The theme's code view in Monaco's options: JetBrains Mono 13/20, a ~60px gutter, no chrome. */
const OPTIONS: Monaco.editor.IStandaloneEditorConstructionOptions = {
  model: null,
  automaticLayout: true,
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 13,
  lineHeight: 20,
  minimap: { enabled: false },
  padding: { top: 12, bottom: 160 },
  scrollBeyondLastLine: false,
  // The glyph margin (20px at this line height) carries the agent bars at the theme's left:10px;
  // three digits of numbers end at 44px and the text starts at 68px, as the theme's gutter does.
  glyphMargin: true,
  folding: false,
  lineNumbersMinChars: 3,
  lineDecorationsWidth: 24,
  renderLineHighlight: 'all',
  overviewRulerLanes: 0,
  overviewRulerBorder: false,
  hideCursorInOverviewRuler: true,
  stickyScroll: { enabled: false },
  guides: { indentation: false },
  bracketPairColorization: { enabled: false },
  scrollbar: { useShadows: false },
  smoothScrolling: true,
  renderWhitespace: 'selection',
  fixedOverflowWidgets: true,
  tabSize: 2,
};

/** One glyph class per agent colour: the bar is a 3px rounded stripe, inset 2px top and bottom. */
const agentBarClass = (colour: string): string =>
  `forge-agent-bar forge-agent-${Math.max(0, (AGENT_COLORS as readonly string[]).indexOf(colour))}`;

const HOST_CSS = [
  '.forge-editor .monaco-editor .line-numbers{font-size:11.5px}',
  '.forge-editor .forge-agent-bar::before{content:"";position:absolute;left:10px;top:2px;bottom:2px;width:3px;border-radius:2px;background:var(--forge-agent)}',
  ...AGENT_COLORS.map(
    (colour, index) => `.forge-editor .forge-agent-${index}{--forge-agent:${colour}}`,
  ),
].join('\n');

/**
 * The workbench's one Monaco editor (a lazy chunk). It shows the active file's model and remembers
 * each file's cursor, scroll and folding; the models live in the registry, so switching tabs or
 * modes loses nothing (§2.3).
 */
export function EditorHost({ projectId, path, initial, touch }: EditorHostProps) {
  const container = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const bars = useRef<Monaco.editor.IEditorDecorationsCollection | null>(null);
  /** The file whose model the editor shows now, so unmounting can save its place first. */
  const shown = useRef<{ projectId: string; path: string } | null>(null);
  const theme = useResolvedTheme();
  const reveal = useEditorStore((state) => state.projects[projectId]?.reveal);

  useEffect(() => applyForgeTheme(monaco, theme), [theme]);

  useEffect(() => {
    if (container.current === null) return;
    const editor = monaco.editor.create(container.current, OPTIONS);
    editorRef.current = editor;
    setActiveEditor(editor);
    bars.current = editor.createDecorationsCollection();
    const cursor = editor.onDidChangeCursorPosition((event) =>
      useEditorStatus.getState().setCursor(event.position.lineNumber, event.position.column),
    );
    return () => {
      // Before dispose: a disposed editor has detached its model and has no view state to give.
      if (shown.current !== null) {
        saveViewState(shown.current.projectId, shown.current.path, editor.saveViewState());
      }
      cursor.dispose();
      setActiveEditor(undefined);
      editor.dispose();
      editorRef.current = null;
      bars.current = null;
      // no text file in the editor: the footer hides its cursor line (D330)
      useEditorStatus.getState().clear();
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
      useEditorStatus.getState().clear();
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
    useEditorStatus.getState().describe(path, model, loadedBom);
    const position = editor.getPosition();
    if (position) useEditorStatus.getState().setCursor(position.lineNumber, position.column);
    return () => {
      // On a path change the editor is alive; on unmount the creation cleanup has already saved.
      saveViewState(projectId, path, editor.saveViewState());
    };
    // `initial` only seeds a new model (see above), so it is not a dependency.
  }, [projectId, path]);

  // The agent's bar beside the lines its last write covers, kept in step with the buffer (D334).
  useEffect(() => {
    const model = editorRef.current?.getModel();
    const collection = bars.current;
    if (model === null || model === undefined || collection === null) return;
    const paint = (): void => {
      const lines = touch === undefined ? undefined : touchedLines(model.getValue(), touch.edit);
      collection.set(
        lines === undefined || touch === undefined
          ? []
          : [
              {
                range: new monaco.Range(lines.from, 1, lines.to, 1),
                options: {
                  isWholeLine: true,
                  glyphMarginClassName: agentBarClass(touch.agent.color),
                },
              },
            ],
      );
    };
    paint();
    const subscription = model.onDidChangeContent(paint);
    return () => {
      subscription.dispose();
      collection.clear();
    };
  }, [projectId, path, touch]);

  useEffect(() => {
    const editor = editorRef.current;
    if (editor === null || reveal === undefined || reveal.path !== path) return;
    editor.revealLineInCenter(reveal.line);
    editor.setPosition({ lineNumber: reveal.line, column: reveal.column });
    editor.focus();
    useEditorStore.getState().revealDone(projectId);
  }, [reveal, path, projectId]);

  return (
    <div className="forge-editor h-full w-full">
      <style>{HOST_CSS}</style>
      <div ref={container} className="h-full w-full" data-testid="monaco-host" />
    </div>
  );
}
