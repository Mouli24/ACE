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
  /** A CLI (Claude Code, Codex, Gemini) works with its own file tools, not ACE's by name. */
  ownTools?: boolean;
  /** A chat turn: the person reads the reply, and no node comes after it. */
  chat?: boolean;
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

  const own = input.ownTools === true;
  const rules: string[] = [
    `You work like a coding agent inside the project folder ${input.workspaceRoot} on ${os}, with the tools you are given. Your access: ${ACCESS_WORDS[access]}.${own ? '' : ` The shell on this computer is ${input.shell}.`}`,
    '- The person sees this folder in Forge, ACE\'s code editor. "In Forge" means in these project files (it has nothing to do with Minecraft Forge).',
    '- Give every path relative to the project folder, with forward slashes (src/app.ts). Never reach outside it.',
    own
      ? '- Look before you act: list and read the files you need first rather than guessing.'
      : '- Look before you act: list_files, search and read_file are cheap, and guessing is not.',
  ];
  if (edits) {
    rules.push(
      '- Do the work in the files themselves: create and change them with your tools. Never paste a whole file or a long code block into your answer instead of writing it — code that is only in your answer is lost.',
      '- Split a big program into several files of at most about 200 lines each, and write each one with its own call, so no single call is cut off.',
    );
    rules.push(
      ...(own
        ? ['- Read a file before you edit it, and prefer small edits to rewriting a whole file.']
        : [
            '- Read a file with read_file before you edit it. If an edit says the file changed since you read it, read it again and redo the edit.',
            '- Prefer edit_file (a small, unique oldString and its newString) to rewriting a whole file with write_file; use write_file for new files.',
          ]),
    );
  }
  if (commands && own) {
    rules.push(
      '- Commands run with no terminal attached: nothing can answer a prompt. Use non-interactive flags (-y, --yes, CI=1).',
      '- Only the commands this node is allowed run. If one is refused, do not retry it: find another way, or say what you needed and why.',
    );
  } else if (commands) {
    rules.push(
      `- run_command runs in ${input.shell}, in the project folder, with no terminal attached: nothing can answer a prompt. Use non-interactive flags (-y, --yes, CI=1).`,
      '- Start servers and watchers with background: true, then check them with command_output, and stop them with kill_command once you no longer need them.',
      '- A command may wait for the person to approve it. If they deny it, do not run it again: find another way, or say what you needed and why.',
    );
  }
  if (input.chat !== true) {
    rules.push(
      "- Stay inside this node's task and its output contract. The nodes after you have their own tasks: leave their work to them.",
    );
  }

  const upstream = input.upstream ?? [];
  if (upstream.length > 0) {
    const files = new Set(upstream.flatMap((step) => step.filesChanged.map((file) => file.path)));
    const ran = upstream.reduce((sum, step) => sum + step.commands.length, 0);
    rules.push(
      `- The nodes before you already worked in this folder (${files.size} ${files.size === 1 ? 'file' : 'files'} changed, ${ran} ${ran === 1 ? 'command' : 'commands'} run), listed under "## Upstream workspace". Build on that work; do not redo or undo it unless your task says so.`,
    );
  }
  rules.push(
    input.chat === true
      ? '- When the task is done, answer without calling a tool: say briefly what you created or changed, by file.'
      : "- When the task is done, answer without calling a tool: say briefly what you created or changed, by file. That answer is this node's output.",
  );

  const instructions = input.instructions.trimEnd();
  return `${instructions === '' ? '' : `${instructions}\n\n`}${AGENT_RULES_HEADING}\n${rules.join('\n')}`;
}
