import type { Project } from '@ace/contracts';
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
} from '@ace/ui';
import { FolderOpen, MoreHorizontal, Plus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import {
  useCreateProject,
  useDeleteProject,
  useOpenProject,
  useProjects,
  useUpdateProject,
} from './hooks';

type DialogState =
  | { kind: 'create' }
  | { kind: 'rename'; project: Project }
  | { kind: 'delete'; project: Project }
  | undefined;

/** `/projects` — list, create, rename, delete, open (FR-PRJ-001/002). */
export function ProjectsPage() {
  const projects = useProjects();
  const [dialog, setDialog] = useState<DialogState>();

  return (
    <main className="mx-auto flex h-full w-full max-w-3xl flex-col gap-6 px-4 py-10">
      <header className="flex items-center justify-between">
        <h1 className="font-human text-2xl font-semibold">Projects</h1>
        <Button onClick={() => setDialog({ kind: 'create' })}>
          <Plus className="h-4 w-4" /> New project
        </Button>
      </header>

      {projects.isPending && <p className="text-fg-muted">Loading projects…</p>}
      {projects.isError && (
        <p role="alert" className="text-danger">
          Could not load projects: {projects.error.message}
        </p>
      )}
      {projects.data?.length === 0 && (
        <p className="rounded-card border border-dashed border-border p-8 text-center text-fg-muted">
          No projects yet. Create one to open the Canvas.
        </p>
      )}

      <ul className="flex flex-col gap-2">
        {projects.data?.map((project) => (
          <ProjectRow key={project.id} project={project} onAction={setDialog} />
        ))}
      </ul>

      {dialog?.kind === 'create' && <CreateProjectDialog onClose={() => setDialog(undefined)} />}
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
