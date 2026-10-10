import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  cn,
} from '@ace/ui';
import { X } from 'lucide-react';

import { FileIcon } from '../explorer/FileIcon';
import { nameOf, parentOf } from '../files/paths';
import { closeFiles } from './actions';
import { useEditorStore, useProjectEditor } from './editor-store';

/** The editor's tabs (§6.2): a dirty dot, middle-click close, Close others / Close saved. */
export function TabsBar({ projectId }: { projectId: string }) {
  const editor = useProjectEditor(projectId);
  const close = (paths: readonly string[]): void => closeFiles(projectId, paths);
  const nameCount = new Map<string, number>();
  for (const tab of editor.tabs) nameCount.set(nameOf(tab), (nameCount.get(nameOf(tab)) ?? 0) + 1);

  return (
    <div
      role="tablist"
      aria-label="Open files"
      className="flex h-9 shrink-0 overflow-x-auto border-b border-border bg-panel"
    >
      {editor.tabs.map((path) => {
        const file = editor.files[path];
        if (file === undefined) return null;
        const active = editor.active === path;
        return (
          <ContextMenu key={path}>
            <ContextMenuTrigger asChild>
              <div
                role="tab"
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                data-testid={`tab-${path}`}
                title={path}
                className={cn(
                  'group flex h-full max-w-[16rem] shrink-0 cursor-pointer items-center gap-1.5 border-r border-border pl-3 pr-1 font-machine text-[12px]',
                  active ? 'bg-canvas text-fg' : 'text-fg-muted hover:text-fg',
                  editor.preview === path && 'italic',
                  file.deletedOnDisk && 'line-through',
                )}
                onClick={() => useEditorStore.getState().activate(projectId, path)}
                onDoubleClick={() => useEditorStore.getState().pin(projectId, path)}
                onAuxClick={(event) => {
                  if (event.button !== 1) return;
                  event.preventDefault();
                  close([path]);
                }}
              >
                <FileIcon path={path} />
                <span className="truncate">{nameOf(path)}</span>
                {(nameCount.get(nameOf(path)) ?? 0) > 1 && (
                  <span className="truncate text-[11px] text-fg-faint">
                    {parentOf(path) === '' ? '/' : parentOf(path)}
                  </span>
                )}
                <button
                  type="button"
                  aria-label={`Close ${nameOf(path)}`}
                  className="ml-1 grid h-5 w-5 shrink-0 place-items-center rounded hover:bg-card"
                  onClick={(event) => {
                    event.stopPropagation();
                    close([path]);
                  }}
                >
                  {file.dirty && (
                    <span
                      data-testid={`dirty-${path}`}
                      aria-label="Unsaved changes"
                      className="h-2 w-2 rounded-full bg-fg group-hover:hidden"
                    />
                  )}
                  <X
                    className={cn('h-3.5 w-3.5', file.dirty && 'hidden group-hover:block')}
                    aria-hidden
                  />
                </button>
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem onSelect={() => close([path])}>Close</ContextMenuItem>
              <ContextMenuItem onSelect={() => close(editor.tabs.filter((tab) => tab !== path))}>
                Close others
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={() =>
                  close(editor.tabs.filter((tab) => editor.files[tab]?.dirty !== true))
                }
              >
                Close saved
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={() => void navigator.clipboard?.writeText(path)}>
                Copy relative path
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        );
      })}
    </div>
  );
}
