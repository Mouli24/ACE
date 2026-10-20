import type { WorkspaceAccess, WorkspaceSummary } from '@ace/contracts';

/**
 * What an agentic node is told about working in the project folder (D375, D342, FR-TOOL-003): the
 * node's own instructions, then the rules a coding agent works by — paths relative to the folder,
 * the OS and the shell, read before edit, small edits over rewrites, non-interactive commands,
 * servers in the background, and staying inside this node's task. It is the node's instructions
 * as the prompt carries them (`## Instructions`); what upstream nodes did is rendered by the prompt
 * itself under `## Upstream workspace` (D378), and only pointed to here.
 */

export interface AgentSystemPromptInput {
  instructions: string;
  /** The project folder, absolute. */
  workspaceRoot: string;
  os: NodeJS.Platform;
  /** The shell `run_command` runs in, as the tools describe it (`Git Bash (…) on Windows`). */
  shell: string;
  access: WorkspaceAccess;
  /** The workspace blocks of the envelopes this node reads, when any upstream node had one. */
  upstream?: WorkspaceSummary[];
}

/** The heading of the rules, under the node's own instructions. */
export const AGENT_RULES_HEADING = '### Working in the project folder';

const OS_NAMES: Partial<Record<NodeJS.Platform, string>> = {
  win32: 'Windows',
  darwin: 'macOS',
  linux: 'Linux',
};

const ACCESS_WORDS: Readonly<Record<WorkspaceAccess, string>> = {
  off: 'none',
  read_only: 'read only — you can look at files but not change them or run commands',
  edit_files: 'edit files — you can read, create and edit files, but not run commands',
  edit_commands: 'edit files and run commands',
};

/** The node's instructions followed by the rules for its access level. */
export function agentSystemPrompt(input: AgentSystemPromptInput): string {
  const { access } = input;
  const edits = access === 'edit_files' || access === 'edit_commands';
  const commands = access === 'edit_commands';
  const os = OS_NAMES[input.os] ?? input.os;

  const rules: string[] = [
    `You work like a coding agent inside the project folder ${input.workspaceRoot} on ${os}, with the tools you are given. Your access: ${ACCESS_WORDS[access]}. The shell on this computer is ${input.shell}.`,
    '- Give every path relative to the project folder, with forward slashes (src/app.ts). Never reach outside it.',
    '- Look before you act: list_files, search and read_file are cheap, and guessing is not.',
  ];
  if (edits) {
    rules.push(
      '- Read a file with read_file before you edit it. If an edit says the file changed since you read it, read it again and redo the edit.',
      '- Prefer edit_file (a small, unique oldString and its newString) to rewriting a whole file with write_file; use write_file for new files.',
    );
  }
  if (commands) {
    rules.push(
      `- run_command runs in ${input.shell}, in the project folder, with no terminal attached: nothing can answer a prompt. Use non-interactive flags (-y, --yes, CI=1).`,
      '- Start servers and watchers with background: true, then check them with command_output, and stop them with kill_command once you no longer need them.',
      '- A command may wait for the person to approve it. If they deny it, do not run it again: find another way, or say what you needed and why.',
    );
  }
  rules.push(
    "- Stay inside this node's task and its output contract. The nodes after you have their own tasks: leave their work to them.",
  );

  const upstream = input.upstream ?? [];
  if (upstream.length > 0) {
    const files = new Set(upstream.flatMap((step) => step.filesChanged.map((file) => file.path)));
    const ran = upstream.reduce((sum, step) => sum + step.commands.length, 0);
    rules.push(
      `- The nodes before you already worked in this folder (${files.size} ${files.size === 1 ? 'file' : 'files'} changed, ${ran} ${ran === 1 ? 'command' : 'commands'} run), listed under "## Upstream workspace". Build on that work; do not redo or undo it unless your task says so.`,
    );
  }
  rules.push(
    "- When the task is done, answer without calling a tool. That answer is this node's output.",
  );

  const own = input.instructions.trimEnd();
  return `${own === '' ? '' : `${own}\n\n`}${AGENT_RULES_HEADING}\n${rules.join('\n')}`;
}
