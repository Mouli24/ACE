import {
  ALLOWED_COMMANDS_MAX,
  MAX_TURNS_LIMIT,
  TOKEN_BUDGET_MAX,
  TOKEN_BUDGET_MIN,
  WORKSPACE_ACCESS,
  agentWorkspaceOf,
  isCliProviderType,
  type AgentConfig,
  type AgentWorkspace,
  type CliProviderType,
  type WorkspaceAccess,
} from '@ace/contracts';
import { Button, FIELD_LABEL_CLASS, Icons, Input } from '@ace/ui';
import { useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';

import { useProject } from '../projects/hooks';
import { useModels, useProviders } from '../providers/hooks';
import { ERROR_CLASS, Field, HELP_CLASS, NumberField } from './fields';

/**
 * The Agent node's Workspace access section (agentic nodes, D342, D346, D375): which of the four
 * levels the node works at, its turn cap, an optional token budget and the commands it may run
 * without asking. No Full auto level exists.
 */

const OPTIONS: Readonly<Record<WorkspaceAccess, { label: string; line: string }>> = {
  off: { label: 'Off', line: "Answers in chat only. Doesn't touch the project." },
  read_only: { label: 'Read only', line: "Reads and searches the project's files." },
  edit_files: { label: 'Edit files', line: 'Reads, creates and edits files in the project.' },
  edit_commands: {
    label: 'Edit + commands',
    line: "Also runs terminal commands. Each one asks first unless you've always-allowed it.",
  },
};

/**
 * D383: what each coding-agent CLI does at a level, from its own `--help`. `note` is shown under the
 * selector; `unavailable` disables the level with its reason. A level absent here follows `OPTIONS`.
 */
const CLI_LEVELS: Readonly<
  Record<CliProviderType, Partial<Record<WorkspaceAccess, { note?: string; unavailable?: string }>>>
> = {
  claude_code: {
    edit_commands: { note: "Runs only the commands you've always-allowed; others are refused." },
  },
  codex_cli: {
    edit_files: { note: 'Codex also runs commands inside its sandbox.' },
    edit_commands: { note: 'Codex runs commands inside its sandbox; the allowed list is not used.' },
  },
  gemini_cli: {
    edit_commands: {
      unavailable: 'Gemini CLI has no per-command allowlist, so it cannot run commands here.',
    },
  },
};

/** D346: said whenever commands can run. */
export const COMMANDS_UNSANDBOXED =
  'Commands run on this computer with your permissions. They are not sandboxed.';

/** A shell operator, newline, substitution or redirect: anything that makes a line more than one command. */
const COMPOUND = /[;&|<>`\r\n]|\$\(/;

/**
 * Why `text` cannot be saved as an allowed prefix, or undefined when it can. A prefix is the start
 * of one simple command such as `npm test`; a compound line would allow more than was typed (D348).
 */
export function allowedCommandProblem(
  text: string,
  existing: readonly string[],
): string | undefined {
  const prefix = text.trim();
  if (prefix === '') return 'Enter a command prefix such as npm test.';
  if (COMPOUND.test(prefix))
    return 'Enter one command only: no ; && || | & > < $( or backticks, and no new lines.';
  if (prefix.length > 200) return 'That prefix is too long (200 characters at most).';
  if (existing.includes(prefix)) return 'That prefix is already on the list.';
  if (existing.length >= ALLOWED_COMMANDS_MAX) return `At most ${ALLOWED_COMMANDS_MAX} commands.`;
  return undefined;
}

function AllowedCommands({
  commands,
  onChange,
}: {
  commands: string[];
  onChange: (commands: string[]) => void;
}) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string>();

  const add = () => {
    if (draft.trim() === '') return;
    const problem = allowedCommandProblem(draft, commands);
    if (problem !== undefined) {
      setError(problem);
      return;
    }
    onChange([...commands, draft.trim()]);
    setDraft('');
    setError(undefined);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      add();
    }
  };

  return (
    <Field
      label="Allowed commands"
      htmlFor="allowed-command-input"
      {...(error === undefined
        ? { hint: 'Commands starting with one of these run without asking. Others ask first.' }
        : { error })}
    >
      {commands.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" data-testid="allowed-commands">
          {commands.map((command) => (
            <li
              key={command}
              data-testid={`allowed-command-${command}`}
              className="inline-flex items-center gap-1.5 rounded-[4px] bg-[var(--hover)] py-0.5 pl-1.5 pr-1 font-machine text-[11px] text-[var(--ink)]"
            >
              {command}
              <button
                type="button"
                aria-label={`Remove ${command}`}
                className="cursor-pointer border-none bg-transparent p-0 text-[10px] text-[var(--muted)] outline-none hover:text-[#c94c27] focus-visible:text-[#c94c27]"
                onClick={() => onChange(commands.filter((each) => each !== command))}
              >
                <Icons.X aria-hidden size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-2">
        <Input
          id="allowed-command-input"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            if (error) setError(undefined);
          }}
          onKeyDown={onKeyDown}
          placeholder="npm test"
          spellCheck={false}
          className="font-machine text-[12px]"
          aria-invalid={error ? true : undefined}
        />
        <Button type="button" variant="secondary" size="lg" onClick={add}>
          Add
        </Button>
      </div>
    </Field>
  );
}

/** Optional token budget: empty means none; a value outside the contract's range is shown, not saved. */
function TokenBudget({
  value,
  onCommit,
}: {
  value: number | undefined;
  onCommit: (value: number | undefined) => void;
}) {
  const [draft, setDraft] = useState(value === undefined ? '' : String(value));
  const [error, setError] = useState<string>();
  const commit = () => {
    const text = draft.trim();
    if (text === '') {
      setError(undefined);
      if (value !== undefined) onCommit(undefined);
      return;
    }
    const n = Number(text);
    if (!Number.isInteger(n) || n < TOKEN_BUDGET_MIN || n > TOKEN_BUDGET_MAX) {
      setError(
        `Enter a whole number from ${TOKEN_BUDGET_MIN} to ${TOKEN_BUDGET_MAX}, or leave it empty.`,
      );
      return;
    }
    setError(undefined);
    if (n !== value) onCommit(n);
  };
  return (
    <Field
      label="Token budget"
      htmlFor="workspace-token-budget"
      {...(error === undefined ? { hint: 'Optional. Empty means no budget.' } : { error })}
    >
      <Input
        id="workspace-token-budget"
        inputMode="numeric"
        value={draft}
        placeholder="No budget"
        aria-invalid={error ? true : undefined}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit();
        }}
        className="font-machine text-[12px]"
      />
    </Field>
  );
}

export function WorkspaceAccessField({
  config,
  projectId,
  onChange,
}: {
  config: AgentConfig;
  projectId?: string | undefined;
  onChange: (workspace: AgentWorkspace) => void;
}) {
  const workspace = agentWorkspaceOf(config);
  const models = useModels(
    config.providerId === undefined ? {} : { providerId: config.providerId },
  );
  const project = useProject(projectId);
  const providers = useProviders();
  const providerType = (providers.data ?? []).find((each) => each.id === config.providerId)?.type;
  // A coding-agent CLI brings its own tools, so its models report no tool support (D383).
  const cliType = providerType !== undefined && isCliProviderType(providerType) ? providerType : undefined;
  const cliLevels = cliType === undefined ? undefined : CLI_LEVELS[cliType];

  const model = (models.data?.items ?? []).find(
    (each) => each.providerId === config.providerId && each.modelId === config.modelId,
  );
  const noTools = cliType === undefined && model?.supportsTools === false;
  const noFolder = project.data !== undefined && project.data.folderPath.trim() === '';
  const disabled = noTools || noFolder;
  const set = (patch: Partial<AgentWorkspace>) => {
    const next: AgentWorkspace = { ...workspace, ...patch };
    if (next.tokenBudget === undefined) delete next.tokenBudget;
    onChange(next);
  };

  return (
    <div className="flex min-w-0 flex-col gap-[7px]" data-testid="workspace-access">
      <span id="workspace-access-label" className={FIELD_LABEL_CLASS}>
        Workspace access
      </span>
      <div
        role="radiogroup"
        aria-labelledby="workspace-access-label"
        className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-2"
      >
        {WORKSPACE_ACCESS.map((level) => {
          const on = workspace.access === level;
          return (
            <button
              key={level}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={(disabled || cliLevels?.[level]?.unavailable !== undefined) && level !== 'off'}
              title={cliLevels?.[level]?.unavailable}
              data-testid={`workspace-access-${level}`}
              onClick={() => set({ access: level })}
              className={`flex cursor-pointer flex-col gap-0.5 rounded-[9px] border bg-transparent px-3 py-2.5 text-left text-[var(--ink)] outline-none hover:bg-[var(--hover)] focus-visible:border-[#ef6b3f] disabled:cursor-not-allowed disabled:opacity-50 ${
                on ? 'border-[#ef6b3f]' : 'border-[var(--line)]'
              }`}
            >
              <span className="text-[12.5px] font-semibold">{OPTIONS[level].label}</span>
              <span className="text-[10.5px] text-[var(--muted)]">{OPTIONS[level].line}</span>
            </button>
          );
        })}
      </div>
      {cliLevels?.[workspace.access]?.note !== undefined && (
        <p role="note" data-testid="workspace-cli-note" className={HELP_CLASS}>
          {cliLevels[workspace.access]?.note}
        </p>
      )}
      {Object.entries(cliLevels ?? {}).map(([level, entry]) =>
        entry.unavailable === undefined ? null : (
          <p key={level} role="note" data-testid={`workspace-cli-unavailable-${level}`} className={HELP_CLASS}>
            {OPTIONS[level as WorkspaceAccess].label}: {entry.unavailable}
          </p>
        ),
      )}
      {noTools && (
        <p role="note" data-testid="workspace-no-tools" className={HELP_CLASS}>
          This model can&apos;t use tools.{' '}
          <Link to="/providers">Turn tools on for it in Providers</Link> if it can.
        </p>
      )}
      {!noTools && noFolder && (
        <p role="note" data-testid="workspace-no-folder" className={HELP_CLASS}>
          Give the project a folder first.
        </p>
      )}
      {workspace.access === 'edit_commands' && (
        <p role="note" data-testid="workspace-unsandboxed" className={ERROR_CLASS}>
          {COMMANDS_UNSANDBOXED}
        </p>
      )}
      {workspace.access !== 'off' && (
        <div className="flex min-w-0 flex-col gap-5">
          <NumberField
            label="Max turns"
            value={workspace.maxTurns}
            range={{ min: 1, max: MAX_TURNS_LIMIT, integer: true }}
            onCommit={(maxTurns) => set({ maxTurns })}
          />
          <TokenBudget
            value={workspace.tokenBudget}
            onCommit={(tokenBudget) => {
              const { tokenBudget: _drop, ...rest } = workspace;
              onChange(tokenBudget === undefined ? rest : { ...rest, tokenBudget });
            }}
          />
          <AllowedCommands
            commands={workspace.allowedCommands}
            onChange={(allowedCommands) => set({ allowedCommands })}
          />
        </div>
      )}
    </div>
  );
}
