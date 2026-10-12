import { PROCESS_OUTPUT_MAX_CHARS } from '@ace/contracts';
import { create } from 'zustand';

import { initialLineState, promptFor, settleLine, type LineState } from './line-discipline';

/**
 * Terminal tabs, per project (D301, design §2.3): outside every component, so a tab's scrollback,
 * folder, history and half-typed line survive Ideate ↔ Forge and a hidden panel. In memory only:
 * a reload starts with no tabs, and the engine's processes show in the Processes list.
 */

/** A tab keeps as much as the engine keeps per process. */
export const TERMINAL_SCROLLBACK_MAX = PROCESS_OUTPUT_MAX_CHARS;
/** Processes no tab owns, whose output is held for the Processes list. */
export const UNOWNED_MAX = 20;

export interface ExitInfo {
  exitCode: number | null;
  signal: string | null;
  status: 'exited' | 'failed';
}

export interface TerminalTab {
  id: string;
  label: string;
  /** Project-relative; `''` is the root. Changed by the `cd` built-in only. */
  cwd: string;
  line: LineState;
  /** The process this tab runs, while it runs. */
  processId: string | undefined;
  /** What the tab shows before the attached process's output: prompts, echo, earlier runs. */
  base: string;
  /** The attached process's output, and what was typed to it; a re-attach replaces it. */
  live: string;
  /** Characters ever appended: what a view has not written yet is the difference. */
  total: number;
  /** Bumped when the text is replaced rather than appended; a view then rewrites it all. */
  epoch: number;
}

export interface ProjectTerminals {
  tabs: TerminalTab[];
  active: string | undefined;
  /** The number the next new tab is named by. */
  next: number;
}

export interface UnownedProcess {
  output: string;
  exit: ExitInfo | undefined;
}

export const EMPTY_TERMINALS: ProjectTerminals = { tabs: [], active: undefined, next: 1 };

export const scrollbackOf = (tab: TerminalTab): string => tab.base + tab.live;

const DIM = '\u001b[2m';
const RED = '\u001b[31m';
const RESET = '\u001b[0m';

/** What a tab prints when its process ends: nothing for a clean exit. */
export function exitLine(exit: ExitInfo): string {
  if (exit.status === 'failed') return `${DIM}[could not start]${RESET}\r\n`;
  if (exit.signal !== null) return `${DIM}[stopped (${exit.signal})]${RESET}\r\n`;
  if (exit.exitCode !== null && exit.exitCode !== 0) {
    return `${DIM}[exit ${exit.exitCode}]${RESET}\r\n`;
  }
  return '';
}

/** A refusal or failure, in red, on a line of its own (design §10). */
export const errorLine = (message: string): string => `${RED}${message}${RESET}\r\n`;

export const DROPPED_NOTE = `${DIM}[earlier output dropped: the engine keeps the last 1 MB]${RESET}\r\n`;
export const LOST_NOTE = `${DIM}[the engine no longer knows this process: it stopped when the engine restarted]${RESET}\r\n`;

const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

/** Drops a lone second half of a surrogate pair from the front of a cut. */
const clean = (text: string): string =>
  text !== '' && isLowSurrogate(text.charCodeAt(0)) ? text.slice(1) : text;

/** `base + live` cut to the last {@link TERMINAL_SCROLLBACK_MAX} characters, base first. */
function capped(base: string, live: string): { base: string; live: string } {
  const excess = base.length + live.length - TERMINAL_SCROLLBACK_MAX;
  if (excess <= 0) return { base, live };
  if (excess <= base.length) return { base: clean(base.slice(excess)), live };
  return { base: '', live: clean(live.slice(excess - base.length)) };
}

const keepLast = (text: string): string =>
  text.length <= TERMINAL_SCROLLBACK_MAX ? text : clean(text.slice(-TERMINAL_SCROLLBACK_MAX));

/** Appends to the process's part while one is attached, else before it. */
function append(tab: TerminalTab, text: string, into: 'auto' | 'base' = 'auto'): TerminalTab {
  if (text === '') return tab;
  const toLive = into === 'auto' && tab.processId !== undefined;
  const next = toLive ? capped(tab.base, tab.live + text) : capped(tab.base + text, tab.live);
  return { ...tab, ...next, total: tab.total + text.length };
}

/** The attached process ended: its output joins the rest, how it ended is said, the prompt is back. */
function finish(tab: TerminalTab, ending: string): TerminalTab {
  const shown = scrollbackOf(tab);
  const lineBreak = shown !== '' && !shown.endsWith('\n') ? '\r\n' : '';
  const folded: TerminalTab = {
    ...tab,
    base: tab.base + tab.live,
    live: '',
    processId: undefined,
    line: settleLine(tab.line),
  };
  return append(folded, `${lineBreak}${ending}${promptFor(tab.cwd)}`, 'base');
}

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  const copy = { ...record };
  delete copy[key];
  return copy;
}

/** Changes one unowned entry; past {@link UNOWNED_MAX} the oldest is dropped. */
function remember(
  unowned: Record<string, UnownedProcess>,
  processId: string,
  change: (entry: UnownedProcess) => UnownedProcess,
): Record<string, UnownedProcess> {
  const next = {
    ...unowned,
    [processId]: change(unowned[processId] ?? { output: '', exit: undefined }),
  };
  const keys = Object.keys(next);
  for (const key of keys.slice(0, Math.max(0, keys.length - UNOWNED_MAX))) delete next[key];
  return next;
}

interface TerminalData {
  projects: Record<string, ProjectTerminals>;
  unowned: Record<string, UnownedProcess>;
}

interface TerminalState extends TerminalData {
  /** Opens a tab at its prompt, makes it active, and answers its id. */
  newTab(projectId: string, options?: { label?: string; cwd?: string }): string;
  closeTab(projectId: string, tabId: string): void;
  activate(projectId: string, tabId: string): void;
  rename(projectId: string, tabId: string, label: string): void;
  setLine(projectId: string, tabId: string, line: LineState): void;
  setCwd(projectId: string, tabId: string, cwd: string): void;
  /** Echo, a refusal, a built-in's answer: what the person sees next. */
  write(projectId: string, tabId: string, text: string): void;
  /** `cls` / `clear`. */
  clearScreen(projectId: string, tabId: string): void;
  /** Back to an empty prompt, with nothing running. */
  idle(projectId: string, tabId: string): void;
  /** The tab now runs this process; output and an end that came first are taken in. */
  attach(projectId: string, tabId: string, processId: string): void;
  output(projectId: string, processId: string, data: string): void;
  exited(projectId: string, processId: string, exit: ExitInfo): void;
  /** A re-attach: the engine's copy of the process's output replaces the tab's. */
  replaceLive(projectId: string, processId: string, output: string): void;
  /** The engine no longer knows the process: the run ends with a note. */
  lost(projectId: string, processId: string): void;
  reset(): void;
}

function findOwner(
  state: TerminalData,
  projectId: string,
  processId: string,
): TerminalTab | undefined {
  return state.projects[projectId]?.tabs.find((tab) => tab.processId === processId);
}

function withTab(
  state: TerminalData,
  projectId: string,
  tabId: string,
  change: (tab: TerminalTab) => TerminalTab,
): Partial<TerminalData> {
  const project = state.projects[projectId];
  const index = project?.tabs.findIndex((tab) => tab.id === tabId) ?? -1;
  const current = project?.tabs[index];
  if (project === undefined || current === undefined) return {};
  const tabs = [...project.tabs];
  tabs[index] = change(current);
  return { projects: { ...state.projects, [projectId]: { ...project, tabs } } };
}

export const useTerminalStore = create<TerminalState>()((set) => ({
  projects: {},
  unowned: {},

  newTab(projectId, options = {}) {
    let id = '';
    set((state) => {
      const project = state.projects[projectId] ?? EMPTY_TERMINALS;
      id = `t${project.next}`;
      const cwd = options.cwd ?? '';
      const prompt = promptFor(cwd);
      const tab: TerminalTab = {
        id,
        label: options.label ?? `Terminal ${project.next}`,
        cwd,
        line: initialLineState(),
        processId: undefined,
        base: prompt,
        live: '',
        total: prompt.length,
        epoch: 0,
      };
      return {
        projects: {
          ...state.projects,
          [projectId]: { tabs: [...project.tabs, tab], active: id, next: project.next + 1 },
        },
      };
    });
    return id;
  },

  closeTab: (projectId, tabId) =>
    set((state) => {
      const project = state.projects[projectId];
      if (project === undefined) return {};
      const index = project.tabs.findIndex((tab) => tab.id === tabId);
      if (index === -1) return {};
      const tabs = project.tabs.filter((tab) => tab.id !== tabId);
      const active =
        project.active === tabId ? (tabs[index] ?? tabs[index - 1])?.id : project.active;
      return { projects: { ...state.projects, [projectId]: { ...project, tabs, active } } };
    }),

  activate: (projectId, tabId) =>
    set((state) => {
      const project = state.projects[projectId];
      if (project === undefined || !project.tabs.some((tab) => tab.id === tabId)) return {};
      return { projects: { ...state.projects, [projectId]: { ...project, active: tabId } } };
    }),

  rename: (projectId, tabId, label) =>
    set((state) =>
      label.trim() === ''
        ? {}
        : withTab(state, projectId, tabId, (tab) => ({ ...tab, label: label.trim() })),
    ),

  setLine: (projectId, tabId, line) =>
    set((state) => withTab(state, projectId, tabId, (tab) => ({ ...tab, line }))),

  setCwd: (projectId, tabId, cwd) =>
    set((state) => withTab(state, projectId, tabId, (tab) => ({ ...tab, cwd }))),

  write: (projectId, tabId, text) =>
    set((state) => withTab(state, projectId, tabId, (tab) => append(tab, text))),

  clearScreen: (projectId, tabId) =>
    set((state) =>
      withTab(state, projectId, tabId, (tab) => ({
        ...tab,
        base: '',
        live: '',
        epoch: tab.epoch + 1,
      })),
    ),

  idle: (projectId, tabId) =>
    set((state) =>
      withTab(state, projectId, tabId, (tab) => ({
        ...append(tab, promptFor(tab.cwd), 'base'),
        line: settleLine(tab.line),
      })),
    ),

  attach: (projectId, tabId, processId) =>
    set((state) => {
      const early = state.unowned[processId];
      const change = withTab(state, projectId, tabId, (tab) => {
        const attached = append({ ...tab, processId }, early?.output ?? '');
        return early?.exit === undefined ? attached : finish(attached, exitLine(early.exit));
      });
      return { ...change, unowned: without(state.unowned, processId) };
    }),

  output: (projectId, processId, data) =>
    set((state) => {
      const owner = findOwner(state, projectId, processId);
      if (owner !== undefined)
        return withTab(state, projectId, owner.id, (tab) => append(tab, data));
      return {
        unowned: remember(state.unowned, processId, (entry) => ({
          ...entry,
          output: keepLast(entry.output + data),
        })),
      };
    }),

  exited: (projectId, processId, exit) =>
    set((state) => {
      const owner = findOwner(state, projectId, processId);
      if (owner !== undefined) {
        return withTab(state, projectId, owner.id, (tab) => finish(tab, exitLine(exit)));
      }
      return { unowned: remember(state.unowned, processId, (entry) => ({ ...entry, exit })) };
    }),

  replaceLive: (projectId, processId, output) =>
    set((state) => {
      const owner = findOwner(state, projectId, processId);
      if (owner === undefined) return {};
      return withTab(state, projectId, owner.id, (tab) => ({
        ...tab,
        ...capped(tab.base, output),
        epoch: tab.epoch + 1,
      }));
    }),

  lost: (projectId, processId) =>
    set((state) => {
      const owner = findOwner(state, projectId, processId);
      if (owner === undefined) return {};
      return withTab(state, projectId, owner.id, (tab) => finish(tab, LOST_NOTE));
    }),

  reset: () => set({ projects: {}, unowned: {} }),
}));

/** One project's tabs; a stable empty value for a project with none. */
export function useProjectTerminals(projectId: string): ProjectTerminals {
  return useTerminalStore((state) => state.projects[projectId] ?? EMPTY_TERMINALS);
}

export function tabOf(projectId: string, tabId: string): TerminalTab | undefined {
  return useTerminalStore.getState().projects[projectId]?.tabs.find((tab) => tab.id === tabId);
}

export function ownerOf(projectId: string, processId: string): TerminalTab | undefined {
  return findOwner(useTerminalStore.getState(), projectId, processId);
}
