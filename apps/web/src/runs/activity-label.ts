/**
 * What an agentic node is doing right now, in words for its card and the Explorer (D381).
 * The target is a path or a command, so only its last path segment is shown for files.
 */

const READ_TOOLS: ReadonlySet<string> = new Set(['read_file', 'list_files', 'search']);
const EDIT_TOOLS: ReadonlySet<string> = new Set(['write_file', 'edit_file']);

/** The last segment of a path, either slash. */
const baseName = (path: string): string => path.split(/[/\\]/).filter(Boolean).pop() ?? path;

/** `Reading src/a.js`, `Editing a.js`, `Running npm test`, `Checking npm run dev`, `Stopping a command`. */
export function nodeActivityLabel(tool: { name: string; target?: string | undefined }): string {
  const target = tool.target?.trim();
  const has = target !== undefined && target !== '';
  if (READ_TOOLS.has(tool.name) || tool.name.startsWith('git_')) {
    return has ? `Reading ${target}` : 'Reading the project';
  }
  if (EDIT_TOOLS.has(tool.name)) return has ? `Editing ${baseName(target)}` : 'Editing a file';
  if (tool.name === 'run_command') return has ? `Running ${target}` : 'Running a command';
  if (tool.name === 'command_output') return has ? `Checking ${target}` : 'Checking a command';
  if (tool.name === 'kill_command') return 'Stopping a command';
  return has ? `Using ${tool.name} on ${target}` : `Using ${tool.name}`;
}

/** The label a card shows for a node in this state, or undefined when it shows none. */
export function nodeStatusActivity(
  state: string,
  tool: { name: string; target?: string | undefined } | undefined,
): string | undefined {
  if (state === 'WAITING') return 'Waiting for approval';
  if (state === 'RUNNING' && tool !== undefined) return nodeActivityLabel(tool);
  return undefined;
}
