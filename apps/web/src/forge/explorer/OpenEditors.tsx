import { cn } from '@ace/ui';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronRight, SaveAll, X } from 'lucide-react';
import { useState } from 'react';

import { saveAll } from '../editor/actions';
import { useCloseRequest } from '../editor/CloseDialogs';
import { needsSaveAll, useEditorStore, useProjectEditor } from '../editor/editor-store';
import { nameOf, parentOf } from '../files/paths';
import { IconAction } from '../layout/IconAction';
import { FileIcon } from './FileIcon';

/** The Explorer's "Open editors" section (§6.4): the files the person is editing, unsaved ones marked. */
export function OpenEditors({ projectId }: { projectId: string }) {
  const editor = useProjectEditor(projectId);
  const [collapsed, setCollapsed] = useState(false);
  const queryClient = useQueryClient();
  const { request: close, dialog } = useCloseRequest(projectId);
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
        <IconAction
          label="Save all"
          Icon={SaveAll}
          disabled={
            !editor.tabs.some((path) => {
              const file = editor.files[path];
              return file !== undefined && needsSaveAll(file);
            })
          }
          onClick={() => void saveAll(projectId, queryClient)}
        />
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
                  'group flex h-[22px] items-center gap-1.5 pr-2 font-machine text-[12px]',
                  editor.active === path ? 'bg-selection/20 text-fg' : 'text-fg-soft hover:bg-card',
                )}
              >
                <button
                  type="button"
                  onClick={() => useEditorStore.getState().activate(projectId, path)}
                  className="flex h-full min-w-0 flex-1 items-center gap-1.5 pl-6 text-left"
                >
                  <FileIcon path={path} />
                  <span className="truncate">{nameOf(path)}</span>
                  <span className="min-w-0 flex-1 truncate text-[11px] text-fg-faint">
                    {parentOf(path)}
                  </span>
                  {file?.dirty === true && (
                    <>
                      <span
                        aria-hidden
                        className="h-2 w-2 shrink-0 rounded-full bg-fg group-hover:hidden"
                      />
                      <span className="sr-only"> (unsaved)</span>
                    </>
                  )}
                </button>
                <button
                  type="button"
                  aria-label={`Close ${nameOf(path)}`}
                  onClick={() => close([path])}
                  className="grid h-4 w-4 shrink-0 place-items-center rounded opacity-0 hover:bg-card focus-visible:opacity-100 group-hover:opacity-100"
                >
                  <X className="h-3 w-3" aria-hidden />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {dialog}
    </section>
  );
}
