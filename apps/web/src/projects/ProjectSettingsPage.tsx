import {
  BUILD_CAPACITY_MAX,
  BuildCapacitySchema,
  CHECK_COMMAND_MAX,
  CHECK_COMMANDS_MAX,
  CHECK_NAME_MAX,
  CheckCommandSchema,
  DEFAULT_BUILD_CAPACITY,
  type CheckCommand,
  type Project,
  type UpdateProjectRequest,
} from '@ace/contracts';
import { Button, Input, Label, toast } from '@ace/ui';
import { ArrowDown, ArrowUp, FolderGit2, Plus, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';

import { ConfirmDialog } from '../knowledge/ConfirmDialog';
import { useInitRepository, useRepository } from '../tasks/hooks';
import { shortSha } from '../tasks/meta';
import { useProject, useUpdateProject } from './hooks';
import { ProjectNav } from './ProjectNav';

/**
 * `/projects/:projectId/settings` (ACE parity P0, design §8): the project folder as a Git
 * repository (with Initialize Git), the check commands every work run is checked with, the setup
 * command a new workspace runs, how many tasks may work at once, how a task's app is previewed
 * (P1, D278), and pausing the project. Each section saves on its own, checked by the contract
 * first, with a toast either way — as Settings.
 */
export function ProjectSettingsPage() {
  const { projectId = '' } = useParams();
  const project = useProject(projectId);
  const update = useUpdateProject();

  const save = (patch: UpdateProjectRequest, what: string): Promise<boolean> =>
    update.mutateAsync({ id: projectId, ...patch }).then(
      () => {
        toast.success(`${what} saved`);
        return true;
      },
      (error: unknown) => {
        toast.error(`${what} not saved`, {
          description: error instanceof Error ? error.message : undefined,
        });
        return false;
      },
    );

  if (project.isError) {
    return (
      <p role="alert" className="p-6 text-danger">
        Project not found.{' '}
        <Link to="/projects" className="underline">
          Back to projects
        </Link>
      </p>
    );
  }

  const data = project.data;
  return (
    <main
      data-testid="project-settings"
      className="mx-auto flex h-full w-full max-w-3xl flex-col gap-8 overflow-y-auto px-4 py-8"
    >
      <ProjectNav projectId={projectId} />
      <header>
        <h1 className="font-human text-2xl font-semibold">Project settings</h1>
        <p className="mt-1 font-human text-sm text-fg-muted">
          How {data?.name ?? 'this project'}’s tasks are built, checked and delivered.
        </p>
      </header>

      <RepositorySection projectId={projectId} />

      {data === undefined ? (
        <p className="text-fg-muted">Loading the project…</p>
      ) : (
        <>
          <ChecksSection
            key={JSON.stringify(data.checkCommands ?? [])}
            project={data}
            onSave={(checkCommands) => save({ checkCommands }, 'Checks')}
          />
          <SetupSection
            key={data.setupCommand ?? ''}
            project={data}
            onSave={(setupCommand) => save({ setupCommand }, 'Setup command')}
          />
          <CapacitySection
            key={String(data.buildCapacity ?? DEFAULT_BUILD_CAPACITY)}
            project={data}
            onSave={(buildCapacity) => save({ buildCapacity }, 'Build capacity')}
          />
          <Section title="Preview" testId="project-preview">
            <p className="text-sm text-fg-muted">
              How to run the app for a preview of a task: the command runs in the task’s workspace
              with <code className="font-machine">PORT</code> set to a free port, and the address is
              where you open it.
            </p>
            <OptionalCommand
              key={`command:${data.previewCommand ?? ''}`}
              label="Preview command"
              placeholder="pnpm dev --port $PORT"
              max={CHECK_COMMAND_MAX}
              saved={data.previewCommand ?? ''}
              onSave={(previewCommand) => save({ previewCommand }, 'Preview command')}
            />
            <OptionalCommand
              key={`url:${data.previewUrl ?? ''}`}
              label="Preview URL"
              placeholder="http://localhost:{port}"
              max={PREVIEW_URL_MAX}
              saved={data.previewUrl ?? ''}
              hint={
                <>
                  <code className="font-machine">{'{port}'}</code> is replaced with the port the
                  engine picked. Empty means{' '}
                  <code className="font-machine">{'http://localhost:{port}'}</code>.
                </>
              }
              onSave={(previewUrl) => save({ previewUrl }, 'Preview URL')}
            />
          </Section>
          <Section title="Pause" testId="project-pause">
            <p className="text-sm text-fg-muted">
              {data.paused === true
                ? 'Paused: no task of this project takes an automatic step. Runs already going finish.'
                : 'A paused project’s tasks take no automatic step — no queued work starts and Autopilot waits — while you can still act on them by hand.'}
            </p>
            <Button
              variant="secondary"
              className="self-start"
              disabled={update.isPending}
              onClick={() =>
                void save(
                  { paused: data.paused !== true },
                  data.paused === true ? 'Resume' : 'Pause',
                )
              }
            >
              {data.paused === true ? 'Resume project' : 'Pause project'}
            </Button>
          </Section>
        </>
      )}
    </main>
  );
}

function Section({
  title,
  testId,
  children,
}: {
  title: string;
  testId: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3" data-testid={testId} aria-label={title}>
      <h2 className="font-human text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="font-machine text-[10px] uppercase tracking-[0.1em] text-fg-muted">{label}</dt>
      <dd className="min-w-0 break-all font-machine text-xs text-fg">{children}</dd>
    </div>
  );
}

function RepositorySection({ projectId }: { projectId: string }) {
  const repository = useRepository(projectId);
  const init = useInitRepository(projectId);
  const [confirming, setConfirming] = useState(false);
  const info = repository.data;

  return (
    <Section title="Repository" testId="project-repository">
      {repository.isPending && <p className="text-sm text-fg-muted">Reading the folder…</p>}
      {repository.isError && (
        <p role="alert" className="text-sm text-danger">
          Could not read the repository: {repository.error.message}
        </p>
      )}
      {info !== undefined && (
        <>
          <dl className="grid grid-cols-1 gap-3 rounded-card border border-border bg-panel p-4 sm:grid-cols-2">
            <Fact label="Folder">{info.folderPath}</Fact>
            <Fact label="Git">{info.gitAvailable ? 'available' : 'not found on this machine'}</Fact>
            <Fact label="Git repository">{info.isRepo ? 'yes' : 'no'}</Fact>
            {info.isRepo && (
              <>
                <Fact label="Branch">{info.branch ?? 'detached HEAD'}</Fact>
                <Fact label="Head">
                  {info.headSha === undefined ? 'no commit yet' : shortSha(info.headSha)}
                </Fact>
                <Fact label="Working tree">
                  {info.clean === false
                    ? `${info.changedFiles ?? 0} changed ${info.changedFiles === 1 ? 'file' : 'files'}`
                    : 'clean'}
                </Fact>
                {info.remoteUrl !== undefined && <Fact label="Remote">{info.remoteUrl}</Fact>}
              </>
            )}
          </dl>
          {!info.isRepo && (
            <div className="flex flex-col gap-2">
              <p className="text-sm text-fg-muted">
                App tasks work in their own Git branch, so the project folder has to be a Git
                repository with at least one commit.
              </p>
              <Button
                className="self-start"
                disabled={!info.gitAvailable || init.isPending}
                onClick={() => setConfirming(true)}
              >
                <FolderGit2 className="h-4 w-4" aria-hidden /> Initialize Git
              </Button>
            </div>
          )}
        </>
      )}
      {confirming && info !== undefined && (
        <ConfirmDialog
          title="Initialize Git here?"
          description="ACE runs git init in the project folder and makes a first commit of everything in it, so tasks can branch from it. Nothing is pushed anywhere."
          confirmLabel="Initialize Git"
          variant="default"
          pending={init.isPending}
          error={init.error}
          onClose={() => setConfirming(false)}
          onConfirm={() =>
            init.mutate(undefined, {
              onSuccess: () => {
                setConfirming(false);
                toast.success('Git initialized');
              },
            })
          }
        >
          <p className="rounded-field border border-border bg-sunken px-3 py-2 font-machine text-xs">
            {info.folderPath}
          </p>
        </ConfirmDialog>
      )}
    </Section>
  );
}

type CheckRow = { key: number; name: string; command: string };

function ChecksSection({
  project,
  onSave,
}: {
  project: Project;
  onSave: (checks: CheckCommand[]) => Promise<boolean>;
}) {
  const [rows, setRows] = useState<CheckRow[]>(() =>
    (project.checkCommands ?? []).map((check, index) => ({ key: index, ...check })),
  );
  const [nextKey, setNextKey] = useState(rows.length);
  const [error, setError] = useState<string>();

  const change = (key: number, patch: Partial<CheckRow>) =>
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  const move = (index: number, by: -1 | 1) =>
    setRows((current) => {
      const next = [...current];
      const [row] = next.splice(index, 1);
      if (row !== undefined) next.splice(index + by, 0, row);
      return next;
    });
  const add = () => {
    setRows((current) => [...current, { key: nextKey, name: '', command: '' }]);
    setNextKey((key) => key + 1);
  };

  const submit = () => {
    const checks: CheckCommand[] = [];
    for (const [index, row] of rows.entries()) {
      const parsed = CheckCommandSchema.safeParse({ name: row.name, command: row.command });
      if (!parsed.success) {
        setError(`Check ${index + 1} needs a name and a command.`);
        return;
      }
      checks.push(parsed.data);
    }
    if (new Set(checks.map((check) => check.name)).size !== checks.length) {
      setError('Each check needs its own name.');
      return;
    }
    setError(undefined);
    void onSave(checks);
  };

  return (
    <Section title="Checks" testId="project-checks">
      <p className="text-sm text-fg-muted">
        Commands run in order in a task’s workspace after each work run, e.g.{' '}
        <code className="font-machine">pnpm test</code>. A failed check blocks Apply.
      </p>
      {rows.length === 0 ? (
        <p className="text-sm text-fg-faint">No checks yet.</p>
      ) : (
        <ol className="flex flex-col gap-2" aria-label="Check commands">
          {rows.map((row, index) => (
            <li key={row.key} className="flex flex-wrap items-center gap-2">
              <Input
                aria-label={`Check ${index + 1} name`}
                placeholder="test"
                value={row.name}
                maxLength={CHECK_NAME_MAX}
                className="w-36"
                onChange={(event) => change(row.key, { name: event.target.value })}
              />
              <Input
                aria-label={`Check ${index + 1} command`}
                placeholder="pnpm test"
                value={row.command}
                maxLength={CHECK_COMMAND_MAX}
                className="min-w-0 flex-1 font-machine"
                onChange={(event) => change(row.key, { command: event.target.value })}
              />
              <Button
                size="icon"
                variant="ghost"
                aria-label={`Move check ${index + 1} up`}
                disabled={index === 0}
                onClick={() => move(index, -1)}
              >
                <ArrowUp className="h-4 w-4" aria-hidden />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                aria-label={`Move check ${index + 1} down`}
                disabled={index === rows.length - 1}
                onClick={() => move(index, 1)}
              >
                <ArrowDown className="h-4 w-4" aria-hidden />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                aria-label={`Remove check ${index + 1}`}
                onClick={() => setRows((current) => current.filter((r) => r.key !== row.key))}
              >
                <X className="h-4 w-4" aria-hidden />
              </Button>
            </li>
          ))}
        </ol>
      )}
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={rows.length >= CHECK_COMMANDS_MAX}
          onClick={add}
        >
          <Plus className="h-3.5 w-3.5" aria-hidden /> Add check
        </Button>
        <Button size="sm" onClick={submit}>
          Save checks
        </Button>
      </div>
    </Section>
  );
}

function SetupSection({
  project,
  onSave,
}: {
  project: Project;
  onSave: (setupCommand: string | null) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(project.setupCommand ?? '');
  const saved = project.setupCommand ?? '';
  return (
    <Section title="Setup command" testId="project-setup">
      <p className="text-sm text-fg-muted">
        Runs once in a new workspace before its first run — installing dependencies, for example.
      </p>
      <div className="flex flex-wrap gap-2">
        <Input
          aria-label="Setup command"
          placeholder="pnpm install"
          value={draft}
          maxLength={CHECK_COMMAND_MAX}
          className="min-w-0 flex-1 font-machine"
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button
          size="sm"
          disabled={draft.trim() === '' || draft.trim() === saved}
          onClick={() => void onSave(draft.trim())}
        >
          Save setup command
        </Button>
        <Button size="sm" variant="ghost" disabled={saved === ''} onClick={() => void onSave(null)}>
          Clear
        </Button>
      </div>
    </Section>
  );
}

/** The contract's bound on `previewUrl` (graph.ts, `UpdateProjectRequest`). */
const PREVIEW_URL_MAX = 400;

/**
 * One optional project command or address, saved on its own and cleared with `null` (D72) — the
 * preview command and URL (ACE parity P1, D278).
 */
function OptionalCommand({
  label,
  placeholder,
  max,
  saved,
  hint,
  onSave,
}: {
  label: string;
  placeholder: string;
  max: number;
  saved: string;
  hint?: ReactNode;
  onSave: (value: string | null) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(saved);
  const id = `project-${label.toLowerCase().replace(/\s+/g, '-')}`;
  // 'Preview URL' → 'preview URL', for the buttons
  const named = label.charAt(0).toLowerCase() + label.slice(1);
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex flex-wrap gap-2">
        <Input
          id={id}
          placeholder={placeholder}
          value={draft}
          maxLength={max}
          className="min-w-0 flex-1 font-machine"
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button
          size="sm"
          disabled={draft.trim() === '' || draft.trim() === saved}
          onClick={() => void onSave(draft.trim())}
        >
          Save {named}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-label={`Clear ${named}`}
          disabled={saved === ''}
          onClick={() => void onSave(null)}
        >
          Clear
        </Button>
      </div>
      {hint !== undefined && <p className="text-xs text-fg-muted">{hint}</p>}
    </div>
  );
}

function CapacitySection({
  project,
  onSave,
}: {
  project: Project;
  onSave: (buildCapacity: number) => Promise<boolean>;
}) {
  const current = project.buildCapacity ?? DEFAULT_BUILD_CAPACITY;
  const [draft, setDraft] = useState(String(current));
  const parsed = BuildCapacitySchema.safeParse(draft.trim() === '' ? Number.NaN : Number(draft));
  return (
    <Section title="Build capacity" testId="project-capacity">
      <Label htmlFor="project-build-capacity" className="text-sm font-normal text-fg-muted">
        How many tasks may run work at once, 1 to {BUILD_CAPACITY_MAX}. More wait in their column as
        queued.
      </Label>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id="project-build-capacity"
          type="number"
          inputMode="numeric"
          min={1}
          max={BUILD_CAPACITY_MAX}
          value={draft}
          aria-invalid={parsed.success ? undefined : true}
          className="w-24"
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button
          size="sm"
          disabled={!parsed.success || parsed.data === current}
          onClick={() => {
            if (parsed.success) void onSave(parsed.data);
          }}
        >
          Save capacity
        </Button>
      </div>
      {!parsed.success && (
        <p role="alert" className="text-xs text-danger">
          Must be a whole number from 1 to {BUILD_CAPACITY_MAX}.
        </p>
      )}
    </Section>
  );
}
