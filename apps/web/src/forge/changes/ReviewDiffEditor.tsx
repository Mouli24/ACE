import type * as Monaco from 'monaco-editor';
import { useEffect, useRef } from 'react';

import { useResolvedTheme } from '../../app/theme';
import { monaco } from '../../config-panel/monaco-loader';
import { applyForgeTheme } from '../editor/forge-theme';
import { languageOf } from '../editor/languages';

/**
 * Monaco's diff editor over an agent's change (D300 §5.3), in CompareView's look: before on the
 * left, after on the right, both read-only. Its own models, disposed with it — never the editor's
 * buffer of the same file.
 */
export function ReviewDiffEditor({
  path,
  before,
  after,
}: {
  path: string;
  before: string;
  after: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const theme = useResolvedTheme();

  // the editor host may not be mounted while reviewing, so the theme follows the toggle from here
  useEffect(() => applyForgeTheme(monaco, theme), [theme]);

  useEffect(() => {
    const element = container.current;
    if (element === null) return;
    const language = languageOf(path);
    const original: Monaco.editor.ITextModel = monaco.editor.createModel(before, language);
    const modified: Monaco.editor.ITextModel = monaco.editor.createModel(after, language);
    const diff = monaco.editor.createDiffEditor(element, {
      automaticLayout: true,
      readOnly: true,
      originalEditable: false,
      renderSideBySide: true,
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 13,
      lineHeight: 20,
      minimap: { enabled: false },
      padding: { top: 12 },
      folding: false,
      renderLineHighlight: 'all',
      overviewRulerLanes: 0,
      overviewRulerBorder: false,
      renderOverviewRuler: false,
      scrollBeyondLastLine: false,
      scrollbar: { useShadows: false },
    });
    diff.setModel({ original, modified });
    return () => {
      diff.dispose();
      original.dispose();
      modified.dispose();
    };
  }, [path, before, after]);

  return (
    <div ref={container} className="h-full w-full bg-[var(--surface)]" data-testid="review-diff" />
  );
}
