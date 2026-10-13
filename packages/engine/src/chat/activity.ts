import { ACTIVITY_SUMMARY_MAX, type ActivityItem, type ActivityKind } from '@ace/contracts';

import { maskSecrets } from '../security/secret-patterns.js';

/**
 * What a chat turn did in the project, one `ActivityItem` per action (D302, design §3.4). A CLI
 * reports its own actions as `activity` chunks; an API model's are the project tool calls the chat
 * tool loop ran. Either way the item is built from the tool's name and arguments only — never from
 * what the tool returned, which for a read is the file itself (design §7). A CLI's own `summary`
 * is exactly that output, so it is not used.
 */

export type ActivityStatus = 'ok' | 'error' | 'refused' | 'blocked';

/** `ReadFile`, `read-file` and `read_file` are one tool to the mapper. */
function normalise(tool: string): string {
  return tool
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

const KIND: Readonly<Record<string, ActivityKind>> = {
  read: 'read',
  read_file: 'read',
  read_many_files: 'read',
  view: 'read',
  notebook_read: 'read',
  list_files: 'read',
  list_directory: 'read',
  ls: 'read',
  git_status: 'read',
  git_diff: 'read',
  web_fetch: 'read',
  write: 'write',
  write_file: 'write',
  create_file: 'write',
  edit: 'edit',
  edit_file: 'edit',
  multi_edit: 'edit',
  replace: 'edit',
  str_replace: 'edit',
  notebook_edit: 'edit',
  apply_patch: 'edit',
  file_change: 'edit',
  bash: 'command',
  command: 'command',
  shell: 'command',
  run_command: 'command',
  run_shell_command: 'command',
  power_shell: 'command',
  grep: 'search',
  glob: 'search',
  search: 'search',
  search_file_content: 'search',
  web_search: 'search',
};

const PATH_KEYS = ['file_path', 'path', 'absolute_path', 'notebook_path', 'filePath', 'dir_path'];
const PATH_MAX = 300;

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const firstString = (bag: Record<string, unknown>, keys: readonly string[]): string | undefined => {
  for (const key of keys) {
    const value = bag[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
};

/** One line, secrets masked, cut to `max` with an ellipsis. */
function clip(text: string, max: number): string {
  const line = maskSecrets(text.replace(/\s+/g, ' ').trim());
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

/** The most of a command its activity keeps. */
const COMMAND_MAX = 80;
/** A heredoc or here-string, or an output redirect (`>`, `>>`, `1>`, `2>`, `&>`). */
const COMMAND_TAIL = /<<|(?:(?<=^|\s)[12&])?>/;

/**
 * What a command's activity says it ran (D302 fix B-M5): its first line, cut before a heredoc and
 * before an output redirect — where a command that writes a file carries the file's text — then
 * capped. Codex's `apply_patch` is only its name. Secrets are masked before the cap, so a cut never
 * leaves part of one behind (and `clip` masks the summary again).
 */
function commandLine(command: string): string {
  const firstLine = command.split(/\r?\n/, 1)[0] ?? '';
  if (/^apply_patch(?:\s|$)/.test(firstLine.trim())) return 'apply_patch';
  const tail = COMMAND_TAIL.exec(firstLine);
  const kept = maskSecrets((tail === null ? firstLine : firstLine.slice(0, tail.index)).trim());
  return kept.length <= COMMAND_MAX ? kept : `${kept.slice(0, COMMAND_MAX - 1)}…`;
}

/** A path the way the person reads it: project-relative, forward slashes. */
export function projectPath(path: string, projectDir: string | undefined): string {
  const slashed = path.replace(/\\/g, '/');
  if (projectDir !== undefined) {
    const root = projectDir.replace(/\\/g, '/').replace(/\/+$/, '');
    const lower = slashed.toLowerCase();
    const rootLower = root.toLowerCase();
    if (lower === rootLower) return '.';
    if (lower.startsWith(`${rootLower}/`)) return slashed.slice(root.length + 1);
  }
  return slashed.replace(/^\.\//, '');
}

/** Codex reports a file change as `{ changes: [{ path, kind }] }`. */
function changesOf(args: Record<string, unknown>): { path: string; kind: string }[] {
  const changes = args['changes'];
  if (!Array.isArray(changes)) return [];
  return changes.flatMap((change) => {
    const bag = record(change);
    const path = bag['path'];
    return typeof path === 'string' ? [{ path, kind: String(bag['kind'] ?? 'update') }] : [];
  });
}

export function activityItemFor(input: {
  tool: string;
  args: unknown;
  status?: ActivityStatus;
  projectDir?: string;
}): ActivityItem {
  const name = normalise(input.tool);
  const args = record(input.args);
  const changes = name === 'file_change' ? changesOf(args) : [];
  let kind: ActivityKind = KIND[name] ?? 'other';
  if (changes.length > 0 && changes.every((change) => change.kind === 'add')) kind = 'write';

  const rawPath = changes[0]?.path ?? firstString(args, PATH_KEYS);
  const path =
    rawPath === undefined ? undefined : clip(projectPath(rawPath, input.projectDir), PATH_MAX);
  const where = path ?? '';

  let summary: string;
  if (changes.length > 1) {
    summary = `${kind === 'write' ? 'Created' : 'Changed'} ${changes.length} files`;
  } else if (name === 'list_files' || name === 'list_directory' || name === 'ls') {
    summary = `Listed ${path ?? 'the project'}`;
  } else if (name === 'git_status') {
    summary = 'Checked git status';
  } else if (name === 'git_diff') {
    summary = path === undefined ? 'Read the git diff' : `Read the git diff of ${where}`;
  } else if (kind === 'command') {
    const command = firstString(args, ['command', 'cmd']);
    summary = command === undefined ? `Ran ${input.tool}` : `Ran ${commandLine(command)}`;
  } else if (kind === 'search') {
    const query = firstString(args, ['pattern', 'query', 'q']);
    summary =
      query === undefined
        ? `Searched${path === undefined ? '' : ` ${where}`}`
        : `Searched for "${query}"${path === undefined ? '' : ` in ${where}`}`;
  } else if (kind === 'read') {
    summary = path === undefined ? `Read with ${input.tool}` : `Read ${where}`;
  } else if (kind === 'write') {
    summary = path === undefined ? `Wrote with ${input.tool}` : `Wrote ${where}`;
  } else if (kind === 'edit') {
    summary = path === undefined ? `Edited with ${input.tool}` : `Edited ${where}`;
  } else {
    summary = `Used ${input.tool}${path === undefined ? '' : ` on ${where}`}`;
  }
  const outcome =
    input.status === 'error'
      ? ' — failed'
      : input.status === 'refused'
        ? ' — refused: not available in chat'
        : input.status === 'blocked'
          ? ' — blocked by a guardrail'
          : '';
  return {
    kind,
    tool: clip(input.tool, 80) || 'tool',
    ...(path === undefined || path === '' ? {} : { path }),
    summary: `${clip(summary, ACTIVITY_SUMMARY_MAX - outcome.length)}${outcome}`,
  };
}
