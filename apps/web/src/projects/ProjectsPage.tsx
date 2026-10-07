import { CloneProjectRequestSchema, type Project } from '@ace/contracts';
import { AceApiError } from '@ace/sdk';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  Label,
  toast,
} from '@ace/ui';
import { FolderOpen, GitBranchPlus, MoreHorizontal, Plus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { AssistantPanel } from '../assistant/AssistantPanel';
import { HelpLink } from '../help/HelpLink';
import {
  useCloneProject,
  useCreateProject,
  useDeleteProject,
  useOpenProject,
  useProjects,
  useUpdateProject,
} from './hooks';

type DialogState =
  | { kind: 'create' }
  | { kind: 'clone' }
  | { kind: 'rename'; project: Project }
  | { kind: 'delete'; project: Project }
  | undefined;

/**
 * `/projects` — list, create, rename, delete, open (FR-PRJ-001/002), and Clone from GitHub
 * (ACE parity P1, D276).
 */
export function ProjectsPage() {
  const projects = useProjects();
  const [dialog, setDialog] = useState<DialogState>();

  return (
    <main className="mx-auto flex h-full w-full max-w-3xl flex-col gap-6 px-4 py-10">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="font-human text-2xl font-semibold">Projects</h1>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => setDialog({ kind: 'clone' })}>
            <GitBranchPlus className="h-4 w-4" /> Clone from GitHub
          </Button>
          <Button onClick={() => setDialog({ kind: 'create' })}>
            <Plus className="h-4 w-4" /> New project
          </Button>
        </div>
      </header>

      <AssistantPanel />

      {projects.isPending && <p className="text-fg-muted">Loading projects…</p>}
      {projects.isError && (
        <p role="alert" className="text-danger">
          Could not load projects: {projects.error.message}
        </p>
      )}
      {projects.data?.length === 0 && (
        <div className="flex flex-col items-center gap-2 rounded-card border border-dashed border-border p-8 text-center">
          <p className="text-fg-muted">No projects yet. Create one to open the Canvas.</p>
          <HelpLink page="getting-started">Getting started</HelpLink>
        </div>
      )}

      <ul className="flex flex-col gap-2">
        {projects.data?.map((project) => (
          <ProjectRow key={project.id} project={project} onAction={setDialog} />
        ))}
      </ul>

      {dialog?.kind === 'create' && <CreateProjectDialog onClose={() => setDialog(undefined)} />}
      {dialog?.kind === 'clone' && <CloneProjectDialog onClose={() => setDialog(undefined)} />}
      {dialog?.kind === 'rename' && (
        <RenameProjectDialog project={dialog.project} onClose={() => setDialog(undefined)} />
      )}
      {dialog?.kind === 'delete' && (
        <DeleteProjectDialog project={dialog.project} onClose={() => setDialog(undefined)} />
      )}
    </main>
  );
}

function ProjectRow({
  project,
  onAction,
}: {
  project: Project;
  onAction: (d: DialogState) => void;
}) {
  const open = useOpenProject();
  const navigate = useNavigate();
  return (
    <li className="flex items-center gap-3 rounded-card border border-border bg-panel px-4 py-3">
      <FolderOpen className="h-4 w-4 text-fg-muted" />
      <Link
        to={`/projects/${project.id}`}
        className="flex-1 font-human text-base hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        onClick={(event) => {
          event.preventDefault();
          open.mutate(project.id, { onSettled: () => navigate(`/projects/${project.id}`) });
        }}
      >
        {project.name}
      </Link>
      <span className="font-machine text-xs text-fg-muted">{project.folderPath}</span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label={`Actions for ${project.name}`}>
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => onAction({ kind: 'rename', project })}>
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem
            className="text-danger"
            onSelect={() => onAction({ kind: 'delete', project })}
          >
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

function CreateProjectDialog({ onClose }: { onClose: () => void }) {
  const create = useCreateProject();
  const [name, setName] = useState('');
  const [folderPath, setFolderPath] = useState('');
  const error = create.error;
  const pathError =
    AceApiError.is(error) && error.code === 'invalid_path'
      ? `${error.message} (${String((error.details as { path?: string } | undefined)?.path ?? folderPath)})`
      : undefined;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate(
      { name: name.trim(), ...(folderPath.trim() ? { folderPath: folderPath.trim() } : {}) },
      { onSuccess: onClose },
    );
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>New project</DialogTitle>
            <DialogDescription>A project holds workflows and a folder on disk.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="project-name">Name</Label>
            <Input
              id="project-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              autoFocus
              required
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="project-folder">Folder path (optional)</Label>
            <Input
              id="project-folder"
              className="font-machine"
              value={folderPath}
              onChange={(e) => setFolderPath(e.target.value)}
              aria-invalid={pathError ? true : undefined}
              placeholder="created if missing"
            />
            {pathError && (
              <p role="alert" className="text-sm text-danger">
                {pathError}
              </p>
            )}
            {error && !pathError && (
              <p role="alert" className="text-sm text-danger">
                {error.message}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || create.isPending}>
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Clone from GitHub (D276): `owner/name` or a github.com URL, cloned by the engine through the
 * signed-in `gh` CLI into a new project, which opens on success. No `gh` signed in is said plainly
 * (422 `not_connected`), as is a clone GitHub refused (502 `delivery_failed`).
 */
function CloneProjectDialog({ onClose }: { onClose: () => void }) {
  const clone = useCloneProject();
  const navigate = useNavigate();
  const [repo, setRepo] = useState('');
  const [name, setName] = useState('');
  const [folderPath, setFolderPath] = useState('');
  const [repoError, setRepoError] = useState<string>();
  const error = clone.error;
  const code = AceApiError.is(error) ? error.code : undefined;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = CloneProjectRequestSchema.safeParse({
      repo: repo.trim(),
      ...(name.trim() === '' ? {} : { name: name.trim() }),
      ...(folderPath.trim() === '' ? {} : { folderPath: folderPath.trim() }),
    });
    if (!parsed.success) {
      const field = String(parsed.error.issues[0]?.path[0] ?? 'repo');
      setRepoError(
        field === 'repo'
          ? 'Name the repository as owner/name or paste its github.com address.'
          : (parsed.error.issues[0]?.message ?? 'Check the fields.'),
      );
      return;
    }
    setRepoError(undefined);
    clone.mutate(parsed.data, {
      onSuccess: (project) => {
        toast.success(`Cloned ${parsed.data.repo} into ${project.folderPath}`);
        onClose();
        navigate(`/projects/${project.id}`);
      },
    });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form onSubmit={submit} noValidate className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Clone from GitHub</DialogTitle>
            <DialogDescription>
              ACE clones the repository with your signed-in GitHub CLI (gh) and makes it a new
              project. ACE never reads your GitHub token.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="clone-repo">Repository</Label>
            <Input
              id="clone-repo"
              className="font-machine"
              value={repo}
              maxLength={400}
              placeholder="owner/name or https://github.com/owner/name"
              autoFocus
              aria-invalid={repoError ? true : undefined}
              onChange={(e) => setRepo(e.target.value)}
            />
            {repoError && (
              <p role="alert" className="text-sm text-danger">
                {repoError}
              </p>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="clone-name">Project name (optional)</Label>
            <Input
              id="clone-name"
              value={name}
              maxLength={120}
              placeholder="the repository’s name"
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="clone-folder">Folder (optional)</Label>
            <Input
              id="clone-folder"
              className="font-machine"
              value={folderPath}
              placeholder="next to your other projects"
              onChange={(e) => setFolderPath(e.target.value)}
            />
          </div>
          {error && (
            <p
              role="alert"
              data-testid="clone-error"
              data-code={code}
              className="text-sm text-danger"
            >
              {code === 'not_connected' ? (
                <>
                  <strong className="font-semibold">GitHub is not connected.</strong>{' '}
                  {error.message}
                </>
              ) : code === 'delivery_failed' ? (
                <>
                  <strong className="font-semibold">The clone failed.</strong> {error.message}
                </>
              ) : (
                error.message
              )}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={repo.trim() === '' || clone.isPending}>
              {clone.isPending ? 'Cloning…' : 'Clone'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RenameProjectDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const update = useUpdateProject();
  const [name, setName] = useState(project.name);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    update.mutate({ id: project.id, name: name.trim() }, { onSuccess: onClose });
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Rename project</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="rename-project">Name</Label>
            <Input
              id="rename-project"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              autoFocus
              required
            />
          </div>
          {update.error && (
            <p role="alert" className="text-sm text-danger">
              {update.error.message}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || update.isPending}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteProjectDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const remove = useDeleteProject();
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete “{project.name}”?</DialogTitle>
          <DialogDescription>
            Its workflows are deleted from ACE. Files in {project.folderPath} stay on disk.
          </DialogDescription>
        </DialogHeader>
        {remove.error && (
          <p role="alert" className="text-sm text-danger">
            {remove.error.message}
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={remove.isPending}
            onClick={() => remove.mutate(project.id, { onSuccess: onClose })}
          >
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
