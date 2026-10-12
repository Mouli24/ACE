import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  cn,
} from '@ace/ui';
import { useState } from 'react';

import { nodeStatusLook } from '../../theme/format';
import { cancelTerminalFocus, requestTerminalFocus } from './focus';
import { useStopProcess } from './hooks';
import { useProjectTerminals, useTerminalStore, type TerminalTab } from './terminal-store';

/** The editor tab strip's 20px close button (D334): × on a tab, + after the last one. */
const SMALL_BUTTON =
  'h-[20px] w-[20px] shrink-0 cursor-pointer rounded-[5px] border-none bg-transparent leading-none text-[var(--muted)] outline-none hover:bg-[var(--hover)] focus-visible:shadow-[0_0_0_2px_#ef6b3f] disabled:cursor-not-allowed disabled:opacity-45';

/** The Stage cards' RUNNING colour, for the dot on a tab whose process runs. */
const RUNNING = nodeStatusLook('RUNNING').color;

/**
 * The Terminal's tabs (D301), drawn as the editor's tab strip (D334): the active one on the surface
 * with the orange top edge, a dot while its process runs, × to close — asking first while it runs,
 * because closing stops it — double-click to rename, and + for another.
 */
export function TerminalTabs({
  projectId,
  disabled = false,
}: {
  projectId: string;
  disabled?: boolean;
}) {
  const terminals = useProjectTerminals(projectId);
  const [renaming, setRenaming] = useState<string | undefined>();
  const [closing, setClosing] = useState<TerminalTab | undefined>();
  const stop = useStopProcess(projectId);
  const store = useTerminalStore.getState;

  const commitRename = (tabId: string, label: string): void => {
    store().rename(projectId, tabId, label);
    setRenaming(undefined);
  };
  const close = (tab: TerminalTab): void => {
    if (tab.processId !== undefined) setClosing(tab);
    // A tab whose start is still in flight has no process yet, so it closes without asking; the
    // process then runs unowned, and the Processes list offers Show and Stop for it.
    else store().closeTab(projectId, tab.id);
  };
  const stopAndClose = async (tab: TerminalTab): Promise<void> => {
    if (tab.processId !== undefined) await stop.mutateAsync(tab.processId).catch(() => undefined);
    store().closeTab(projectId, tab.id);
    setClosing(undefined);
  };

  return (
    <div className="flex min-w-0 flex-1 items-stretch">
      <div
        role="tablist"
        aria-label="Terminals"
        className="flex min-w-0 items-stretch overflow-x-auto"
      >
        {terminals.tabs.map((tab) => {
          const active = tab.id === terminals.active;
          return (
            <div
              key={tab.id}
              role="presentation"
              className={cn(
                'flex shrink-0 items-center gap-[6px] whitespace-nowrap border-r border-[var(--line)] pr-[6px] text-[12px] font-medium',
                active
                  ? 'bg-[var(--surface)] text-[var(--ink)] shadow-[inset_0_2px_0_#ef6b3f]'
                  : 'bg-transparent text-[var(--muted)]',
              )}
            >
              {renaming === tab.id ? (
                <input
                  aria-label={`Rename ${tab.label}`}
                  autoFocus
                  spellCheck={false}
                  defaultValue={tab.label}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') commitRename(tab.id, event.currentTarget.value);
                    if (event.key === 'Escape') setRenaming(undefined);
                  }}
                  onBlur={(event) => commitRename(tab.id, event.currentTarget.value)}
                  className="ml-[8px] h-[22px] w-28 rounded-[6px] border border-[var(--line)] bg-[var(--surface)] px-[6px] text-[12px] text-[var(--ink)] outline-none focus:border-[#ef6b3f]"
                />
              ) : (
                <button
                  type="button"
                  role="tab"
                  aria-selected={active}
                  title="Double-click to rename"
                  onClick={() => {
                    requestTerminalFocus();
                    store().activate(projectId, tab.id);
                  }}
                  onDoubleClick={() => {
                    // The rename box keeps the caret: the click's focus request is dropped.
                    cancelTerminalFocus();
                    setRenaming(tab.id);
                  }}
                  className="flex h-full cursor-pointer items-center gap-[6px] border-none bg-transparent pl-[12px] outline-none focus-visible:shadow-[inset_0_0_0_2px_#ef6b3f]"
                >
                  {tab.processId !== undefined && (
                    <span
                      aria-hidden
                      className="h-[6px] w-[6px] shrink-0 rounded-full"
                      style={{ background: RUNNING }}
                    />
                  )}
                  {tab.label}
                </button>
              )}
              <button
                type="button"
                aria-label={`Close ${tab.label}`}
                title={`Close ${tab.label}`}
                onClick={() => close(tab)}
                className={cn(SMALL_BUTTON, 'text-[12px]')}
              >
                <span aria-hidden>×</span>
              </button>
            </div>
          );
        })}
      </div>
      <button
        type="button"
        aria-label="New terminal"
        title="New terminal"
        disabled={disabled}
        onClick={() => {
          requestTerminalFocus();
          store().newTab(projectId);
        }}
        className={cn(SMALL_BUTTON, 'mx-[6px] self-center text-[14px]')}
      >
        <span aria-hidden>+</span>
      </button>
      {closing !== undefined && (
        <Dialog open onOpenChange={(open) => !open && setClosing(undefined)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{`Stop ${closing.label}?`}</DialogTitle>
              <DialogDescription>
                It is still running. Closing the tab stops it and everything it started.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="secondary" onClick={() => setClosing(undefined)}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={() => void stopAndClose(closing)}>
                Stop and close
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
