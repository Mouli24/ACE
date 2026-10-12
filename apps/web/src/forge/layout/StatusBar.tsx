import { Fragment } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { useLayoutStore } from '../../app/stores/layout';
import { useEditorStatus } from '../editor/editor-status';
import { useEditorStore } from '../editor/editor-store';
import { languageLabel } from '../editor/languages';
import { useProblemsStore, type Problem } from '../panel/problems-store';

const NONE: Problem[] = [];
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/*
 * Forge's status bar (D299, design §2.2) lives in the workspace footer since D330/D334: the
 * problem counts beside the project, the active file's facts on the right.
 */

/** The errors and warnings in the open files; a click opens Problems. */
export function ProblemsCount({ projectId }: { projectId: string }) {
  const problems = useProblemsStore((s) => s.byProject[projectId] ?? NONE);
  const showPanel = useLayoutStore((s) => s.showPanel);
  const errors = problems.filter((p) => p.severity === 'error').length;
  const warnings = problems.filter((p) => p.severity === 'warning').length;
  return (
    <button
      type="button"
      aria-label={`${plural(errors, 'error')}, ${plural(warnings, 'warning')}`}
      title="Problems"
      onClick={() => showPanel('problems')}
      className="flex items-center gap-2 hover:text-fg"
    >
      <span className="flex items-center gap-1">
        <span aria-hidden>✕</span>
        {errors}
      </span>
      <span className="flex items-center gap-1">
        <span aria-hidden>!</span>
        {warnings}
      </span>
    </button>
  );
}

/**
 * `Ln, Col · indentation · encoding · line endings · Language · unsaved` while Forge's editor shows
 * a text file (theme `footExtra`, with VS Code's file facts). The editor reports that file as
 * `path`, null for none, an image, a notice or a comparison.
 */
export function CursorInfo({ projectId }: { projectId: string }) {
  const { path, line, column, language, indentation, bom, eol } = useEditorStatus(
    useShallow((store) => ({
      path: store.path,
      line: store.line,
      column: store.column,
      language: store.language,
      indentation: store.indentation,
      bom: store.bom,
      eol: store.eol,
    })),
  );
  const dirty = useEditorStore((store) =>
    path === null ? false : (store.projects[projectId]?.files[path]?.dirty ?? false),
  );
  if (path === null) return null;
  const facts = [
    `Ln ${line}, Col ${column}`,
    indentation,
    bom ? 'UTF-8 with BOM' : 'UTF-8',
    eol,
    languageLabel(language),
    ...(dirty ? ['unsaved'] : []),
  ];
  return (
    <span data-testid="footer-cursor">
      {facts.map((fact, index) => (
        <Fragment key={fact}>
          {index > 0 && ' · '}
          <span>{fact}</span>
        </Fragment>
      ))}
    </span>
  );
}
