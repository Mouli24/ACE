import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  Icons,
  cn,
} from '@ace/ui';
import { useRef, type KeyboardEvent } from 'react';

import { fileIconColor } from '../../theme/constants';
import { useProjectReviews, useReviewStore } from '../changes/review-store';
import { nameOf, parentOf } from '../files/paths';
import { useCloseRequest } from './CloseDialogs';
import { useEditorStore, useProjectEditor } from './editor-store';

/**
 * The editor's tabs in the theme's strip (§6.2, D334): an orange top edge on the active tab, a dot
 * in place of the close icon while unsaved (icons, not glyphs: PG-1.2, D360), middle-click close, and Close others / Close saved on right click.
 */
export function TabsBar({ projectId }: { projectId: string }) {
  const editor = useProjectEditor(projectId);
  const reviews = useProjectReviews(projectId);
  const { request: close, dialog } = useCloseRequest(projectId);
  const nameCount = new Map<string, number>();
  for (const tab of editor.tabs) nameCount.set(nameOf(tab), (nameCount.get(nameOf(tab)) ?? 0) + 1);

  const tabRefs = useRef(new Map<string, HTMLElement>());
  /** Roving tabindex (WAI-ARIA tabs): arrows move focus and activate, wrapping; Home and End jump. */
  const onKeyDown = (event: KeyboardEvent, path: string): void => {
    const { tabs } = editor;
    const at = tabs.indexOf(path);
    const target =
      event.key === 'ArrowRight'
        ? tabs[(at + 1) % tabs.length]
        : event.key === 'ArrowLeft'
          ? tabs[(at - 1 + tabs.length) % tabs.length]
          : event.key === 'Home'
            ? tabs[0]
            : event.key === 'End'
              ? tabs[tabs.length - 1]
              : undefined;
    if (target === undefined) return;
    event.preventDefault();
    // as a click: the file takes the area back from a review, even the tab already active
    useReviewStore.getState().deactivate(projectId);
    useEditorStore.getState().activate(projectId, target);
    tabRefs.current.get(target)?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label="Open files"
      className="flex h-[36px] shrink-0 items-stretch overflow-x-auto border-b border-[var(--line)] bg-[var(--panel)]"
    >
      {dialog}
      {editor.tabs.map((path) => {
        const file = editor.files[path];
        if (file === undefined) return null;
        // an agent change under review is the selected tab while it shows (D300)
        const active = editor.active === path && reviews.active === undefined;
        return (
          <ContextMenu key={path}>
            <ContextMenuTrigger asChild>
              <div
                role="presentation"
                className={cn(
                  'flex shrink-0 items-center gap-[8px] whitespace-nowrap border-r border-[var(--line)] pr-[8px] text-[12px] font-medium',
                  active
                    ? 'bg-[var(--surface)] text-[var(--ink)] shadow-[inset_0_2px_0_#ef6b3f]'
                    : 'bg-transparent text-[var(--muted)]',
                )}
              >
                <div
                  role="tab"
                  aria-selected={active}
                  tabIndex={active ? 0 : -1}
                  data-testid={`tab-${path}`}
                  ref={(element) => {
                    if (element === null) tabRefs.current.delete(path);
                    else tabRefs.current.set(path, element);
                  }}
                  className={cn(
                    'flex h-full cursor-pointer items-center gap-[8px] pl-[14px] outline-none focus-visible:shadow-[inset_0_0_0_2px_#ef6b3f]',
                    editor.preview === path && 'italic',
                    file.deletedOnDisk && 'line-through',
                  )}
                  onClick={() => {
                    useReviewStore.getState().deactivate(projectId);
                    useEditorStore.getState().activate(projectId, path);
                  }}
                  onDoubleClick={() => useEditorStore.getState().pin(projectId, path)}
                  onKeyDown={(event) => onKeyDown(event, path)}
                  onAuxClick={(event) => {
                    if (event.button !== 1) return;
                    event.preventDefault();
                    close([path]);
                  }}
                >
                  <span
                    aria-hidden
                    className="h-[7px] w-[7px] shrink-0 rounded-full"
                    style={{ background: fileIconColor(path) }}
                  />
                  {nameOf(path)}
                  {(nameCount.get(nameOf(path)) ?? 0) > 1 && (
                    <span className="text-[var(--muted)]">
                      {parentOf(path) === '' ? '/' : parentOf(path)}
                    </span>
                  )}
                  {file.dirty && <span className="sr-only"> (unsaved)</span>}
                </div>
                {/* A sibling of the tab, not inside it (a tab's children are presentational).
                    Keyboard users close with Alt+W. */}
                <button
                  type="button"
                  tabIndex={-1}
                  aria-label={`Close ${nameOf(path)}`}
                  className="h-[20px] w-[20px] shrink-0 cursor-pointer rounded-[5px] border-none bg-transparent text-[12px] leading-none hover:bg-[var(--hover)]"
                  onClick={() => close([path])}
                >
                  {file.dirty ? (
                    <span aria-hidden data-testid={`dirty-${path}`} className="text-[#ef6b3f]">
                      <Icons.Circle aria-hidden size={8} fill="currentColor" strokeWidth={0} />
                    </span>
                  ) : (
                    <span aria-hidden className="text-[var(--muted)]">
                      <Icons.X aria-hidden size={12} />
                    </span>
                  )}
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
      {reviews.reviews.map((review) => {
        const active = reviews.active === review.key;
        const label = `${nameOf(review.path)} (agent change)`;
        const closeReview = () => useReviewStore.getState().close(projectId, review.key);
        return (
          <div
            key={review.key}
            role="presentation"
            className={cn(
              'flex shrink-0 items-center gap-[8px] whitespace-nowrap border-r border-[var(--line)] pr-[8px] text-[12px] font-medium',
              active
                ? 'bg-[var(--surface)] text-[var(--ink)] shadow-[inset_0_2px_0_#ef6b3f]'
                : 'bg-transparent text-[var(--muted)]',
            )}
          >
            <div
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              title={`${review.path} (agent change)`}
              data-testid={`review-tab-${review.path}`}
              className="flex h-full cursor-pointer items-center gap-[8px] pl-[14px] italic outline-none focus-visible:shadow-[inset_0_0_0_2px_#ef6b3f]"
              onClick={() => useReviewStore.getState().activate(projectId, review.key)}
              onAuxClick={(event) => {
                if (event.button !== 1) return;
                event.preventDefault();
                closeReview();
              }}
            >
              <span
                aria-hidden
                className="h-[7px] w-[7px] shrink-0 rounded-full"
                style={{ background: fileIconColor(review.path) }}
              />
              {label}
            </div>
            <button
              type="button"
              tabIndex={-1}
              aria-label={`Close ${label}`}
              className="h-[20px] w-[20px] shrink-0 cursor-pointer rounded-[5px] border-none bg-transparent text-[12px] leading-none hover:bg-[var(--hover)]"
              onClick={closeReview}
            >
              <span aria-hidden className="text-[var(--muted)]">
                <Icons.X aria-hidden size={12} />
              </span>
            </button>
          </div>
        );
      })}
    </div>
  );
}
