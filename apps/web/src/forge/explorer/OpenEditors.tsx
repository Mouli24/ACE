import { cn } from '@ace/ui';
import { ChevronRight, X } from 'lucide-react';
import { useState } from 'react';

import { closeFiles } from '../editor/actions';
import { useEditorStore, useProjectEditor } from '../editor/editor-store';
import { nameOf, parentOf } from '../files/paths';
import { FileIcon } from './FileIcon';

/** The Explorer's "Open editors" section (§6.4): the files the person is editing, unsaved ones marked. */
export function OpenEditors({ projectId }: { projectId: string }) {
  const editor = useProjectEditor(projectId);
  const [collapsed, setCollapsed] = useState(false);
  const close = (paths: readonly string[]): void => closeFiles(projectId, paths);
  return (
    <section aria-label="Open editors" className="shrink-0 border-b border-border">
      <div className="flex h-7 items-center gap-0.5 px-2">
        <button
          type="button"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-1 font-machine text-[11px] font-semibold uppercase tracking-[0.06em] text-fg-soft"
        >
          <ChevronRight
            className={cn('h-3.5 w-3.5 transition-transform', !collapsed && 'rotate-90')}
            aria-hidden
          />
          Open editors
        </button>
      </div>
      {!collapsed && (
        <ul className="pb-1">
          {editor.tabs.length === 0 && (
            <li className="px-6 py-1 text-[12px] text-fg-faint">No open files.</li>
          )}
          {editor.tabs.map((path) => {
            const file = editor.files[path];
            return (
              <li
                key={path}
                data-testid={`open-editor-${path}`}
                className={cn(
                  'group flex h-[22px] cursor-pointer items-center gap-1.5 pl-6 pr-2 font-machine text-[12px]',
                  editor.active === path ? 'bg-selection/20 text-fg' : 'text-fg-soft hover:bg-card',
                )}
                onClick={() => useEditorStore.getState().activate(projectId, path)}
              >
                <FileIcon path={path} />
                <span className="truncate">{nameOf(path)}</span>
                <span className="min-w-0 flex-1 truncate text-[11px] text-fg-faint">
                  {parentOf(path)}
                </span>
                {file?.dirty === true && (
                  <span
                    aria-label="Unsaved changes"
                    className="h-2 w-2 shrink-0 rounded-full bg-fg group-hover:hidden"
                  />
                )}
                <button
                  type="button"
                  aria-label={`Close ${nameOf(path)}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    close([path]);
                  }}
                  className={cn(
                    'h-4 w-4 shrink-0 place-items-center rounded hover:bg-card',
                    file?.dirty === true
                      ? 'hidden group-hover:grid'
                      : 'grid opacity-0 group-hover:opacity-100',
                  )}
                >
                  <X className="h-3 w-3" aria-hidden />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
