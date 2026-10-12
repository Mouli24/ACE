import { Fragment } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { useLayoutStore } from '../../app/stores/layout';
import { nodeStatusLook } from '../../theme/format';
import { useEditorStatus } from '../editor/editor-status';
import { useEditorStore } from '../editor/editor-store';
import { languageLabel } from '../editor/languages';
import { useProblemsStore, type Problem } from '../panel/problems-store';
import { requestTerminalFocus } from '../terminal/focus';
import { runningCount, useProcessList } from '../terminal/hooks';

const NONE: Problem[] = [];
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/*
 * Forge's status bar (D299, design §2.2) is pieces of the workspace footer since D330/D334, in the
 * footer's type: the problem counts and the running processes (D301) after the project slug, the
 * open file's facts first on the right, as the theme's `footExtra`.
 */

/** The Stage cards' RUNNING colour (`#ef6b3f`), for the ▶ of the running count. */
const RUNNING = nodeStatusLook('RUNNING').color;

/**
 * The errors and warnings in the open files; a click opens Problems. Mono, muted like the slug; a
 * mark takes the Validation tab's colour (✕ red, ! accent) while its count is not zero.
 */
export function ProblemsCount({ projectId }: { projectId: string }) {
  const problems = useProblemsStore((s) => s.byProject[projectId] ?? NONE);
  const showPanel = useLayoutStore((s) => s.showPanel);
  const errors = problems.filter((p) => p.severity === 'error').length;
  const warnings = problems.filter((p) => p.severity === 'warning').length;
  return (
    <button
      type="button"
      data-testid="footer-problems"
      aria-label={`${plural(errors, 'error')}, ${plural(warnings, 'warning')}`}
      title="Problems"
      onClick={() => showPanel('problems')}
      className="flex shrink-0 cursor-pointer items-center gap-[8px] rounded-[4px] border-none bg-transparent px-[2px] font-machine text-[10px] text-[var(--muted)] outline-none hover:text-[var(--ink)] focus-visible:shadow-[0_0_0_2px_#ef6b3f]"
    >
      <span className="flex items-center gap-[4px]">
        <span aria-hidden style={errors > 0 ? { color: '#c94c27' } : undefined}>
          ✕
        </span>
        {errors}
      </span>
      <span className="flex items-center gap-[4px]">
        <span
          aria-hidden
          className="font-bold"
          style={warnings > 0 ? { color: '#e8572e' } : undefined}
        >
          !
        </span>
        {warnings}
      </span>
    </button>
  );
}

/**
 * `▶ N running` while the project runs processes (D301), right after the problem counts and in
 * their type; a click opens the Terminal and gives it the focus. Nothing while none runs.
 */
export function RunningCount({ projectId }: { projectId: string }) {
  const running = runningCount(useProcessList(projectId).data);
  const showPanel = useLayoutStore((s) => s.showPanel);
  if (running === 0) return null;
  return (
    <button
      type="button"
      data-testid="footer-running"
      aria-label={`${running} running`}
      title="Running processes: open the Terminal"
      onClick={() => {
        requestTerminalFocus();
        showPanel('terminal');
      }}
      className="flex shrink-0 cursor-pointer items-center gap-[4px] rounded-[4px] border-none bg-transparent px-[2px] font-machine text-[10px] text-[var(--muted)] outline-none hover:text-[var(--ink)] focus-visible:shadow-[0_0_0_2px_#ef6b3f]"
    >
      <span aria-hidden style={{ color: RUNNING }}>
        ▶
      </span>
      {running} running
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
