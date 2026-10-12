import '@xterm/xterm/css/xterm.css';

import { Button } from '@ace/ui';
import { useQueryClient } from '@tanstack/react-query';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import { useEffect, useRef, useState } from 'react';

import { useResolvedTheme } from '../../app/theme';
import { registerTerminalFocus } from './focus';
import { typed } from './session';
import { scrollbackOf, tabOf, useTerminalStore } from './terminal-store';
import { terminalTheme } from './xterm-theme';

/** The Explorer's filter field (D334), a size down: the find box. */
const FIND_FIELD =
  'h-[26px] w-48 rounded-[8px] border border-[var(--line)] bg-[var(--surface)] px-[10px] font-machine text-[11px] text-[var(--ink)] outline-none focus:border-[#ef6b3f]';

/**
 * One terminal tab on screen (D301, design §6.3), in the theme's code view (D334): JetBrains Mono
 * on the surface, coloured from the theme's palettes as Monaco is. xterm only renders: what is
 * typed goes to the line discipline (`typed`), and what the tab shows comes from the terminal
 * store, so unmounting (a hidden panel, Ideate) loses nothing — on mount the stored scrollback is
 * written back. It takes the keyboard focus only when the person asked for the Terminal
 * (`focus.ts`), never on a remount.
 */
export function TerminalView({
  projectId,
  tabId,
  disabled = false,
}: {
  projectId: string;
  tabId: string;
  /** The project's terminal is off: nothing typed is acted on (D301). */
  disabled?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal>();
  const finder = useRef<SearchAddon>();
  const queryClient = useQueryClient();
  const theme = useResolvedTheme();
  /** The theme at mount, so the first frame is already in the right colours. */
  const themeAtMount = useRef(theme);
  themeAtMount.current = theme;
  const [finding, setFinding] = useState(false);
  const [query, setQuery] = useState('');
  const locked = useRef(disabled);
  locked.current = disabled;

  useEffect(() => {
    const element = host.current;
    if (element === null) return;
    const term = new Terminal({
      convertEol: true,
      cursorBlink: true,
      // The code view's mono (D334), a size down for the panel.
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 12,
      lineHeight: 1.25,
      scrollback: 10_000,
      theme: terminalTheme(themeAtMount.current),
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(
      new WebLinksAddon((_event, uri) => window.open(uri, '_blank', 'noopener,noreferrer')),
    );
    term.loadAddon(search);
    // xterm measures its cell once, at open. JetBrains Mono may still be loading (a fresh page with
    // the panel open); jsdom has no `document.fonts`, so tests never take this branch.
    const fontLate = document.fonts?.check("12px 'JetBrains Mono'") === false;
    let mounted = true;
    term.open(element);
    const refit = (): void => {
      try {
        fit.fit();
      } catch {
        // Not laid out yet; the next resize fits it.
      }
    };
    refit();
    if (fontLate) {
      void document.fonts
        .load("12px 'JetBrains Mono'")
        .then(() => {
          if (!mounted) return;
          // The same family spelled differently makes xterm measure again; the same string would not.
          term.options.fontFamily = '"JetBrains Mono", monospace';
          refit();
        })
        .catch(() => undefined);
    }

    // Write back what the tab holds, then follow it. Each change is written as it arrives: a frame
    // is at most 65,536 characters (PROCESS_FRAME_MAX_CHARS, Task 6), well under the 1,048,576 the
    // tab keeps, so an append is always a delta. Only a re-attach or a clear (a new epoch) rewrites.
    const start = tabOf(projectId, tabId);
    let seen = { epoch: start?.epoch ?? 0, total: start?.total ?? 0 };
    if (start !== undefined) term.write(scrollbackOf(start));
    const unsubscribe = useTerminalStore.subscribe((state) => {
      const tab = state.projects[projectId]?.tabs.find((each) => each.id === tabId);
      if (tab === undefined || (tab.epoch === seen.epoch && tab.total === seen.total)) return;
      const text = scrollbackOf(tab);
      const delta = tab.total - seen.total;
      if (tab.epoch !== seen.epoch || delta > text.length) {
        // ESC c (RIS) rides in the write stream: reset() would not wait for writes still queued.
        term.write(`\u001bc${text}`);
      } else if (delta > 0) {
        term.write(text.slice(text.length - delta));
      }
      seen = { epoch: tab.epoch, total: tab.total };
    });

    const input = term.onData((data) => {
      if (!locked.current) void typed(projectId, tabId, data, queryClient);
    });
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true;
      const mod = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      // With a selection Ctrl+C copies, as in VS Code; without one it is ^C.
      if (mod && key === 'c' && term.hasSelection()) return false;
      // The browser pastes; xterm reports the pasted text as typed.
      if (mod && key === 'v') return false;
      if (mod && key === 'f') {
        event.preventDefault();
        setFinding(true);
        return false;
      }
      return true;
    });
    const observer = new ResizeObserver(refit);
    observer.observe(element);
    terminal.current = term;
    finder.current = search;
    const unregister = registerTerminalFocus(() => term.focus());

    return () => {
      mounted = false;
      unregister();
      observer.disconnect();
      unsubscribe();
      input.dispose();
      term.dispose();
      terminal.current = undefined;
      finder.current = undefined;
    };
  }, [projectId, tabId, queryClient]);

  useEffect(() => {
    if (terminal.current !== undefined) terminal.current.options.theme = terminalTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (terminal.current !== undefined) terminal.current.options.disableStdin = disabled;
  }, [disabled]);

  const find = (direction: 'next' | 'previous'): void => {
    if (query === '') return;
    if (direction === 'next') finder.current?.findNext(query);
    else finder.current?.findPrevious(query);
  };
  const closeFind = (): void => {
    setFinding(false);
    finder.current?.clearDecorations();
    terminal.current?.focus();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {finding && (
        <div
          role="search"
          className="flex shrink-0 items-center gap-[4px] border-b border-[var(--line)] px-[10px] py-[4px]"
        >
          <input
            aria-label="Find in terminal"
            autoFocus
            spellCheck={false}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') find(event.shiftKey ? 'previous' : 'next');
              if (event.key === 'Escape') closeFind();
            }}
            className={FIND_FIELD}
          />
          <Button
            variant="ghost"
            size="icon"
            aria-label="Previous match"
            title="Previous match"
            onClick={() => find('previous')}
          >
            <span aria-hidden>↑</span>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Next match"
            title="Next match"
            onClick={() => find('next')}
          >
            <span aria-hidden>↓</span>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Close find"
            title="Close find"
            onClick={closeFind}
          >
            <span aria-hidden>✕</span>
          </Button>
        </div>
      )}
      {/* xterm's parent has no padding: FitAddon sizes from the parent's box and subtracts only
          xterm's own padding, so a padded parent would fit rows that overflow and get clipped. */}
      <div className="flex min-h-0 flex-1 flex-col px-[12px] pb-[4px] pt-[8px]">
        <div ref={host} data-testid="terminal-view" className="min-h-0 flex-1" />
      </div>
    </div>
  );
}
