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
  Input,
  Label,
} from '@ace/ui';
import { useState, type FormEvent } from 'react';

import { useCreateProject, useDeleteProject, useUpdateProject } from './hooks';

/*
 * The project dialogs (FR-PRJ-001/002): Home's Canvas and Forge cards open New project; the
 * workspace's "…" menu opens Rename and Delete (D331, D337). The theme's modal shell, field
 * labels and pills come from the kit.
 */

/** A labelled field: label over control, 7px apart, as in the theme's settings modal. */
const FIELD = 'flex flex-col gap-[7px]';
/** An inline error line in the theme's red. */
const ERROR_LINE = 'text-[12px] text-[#c94c27]';

export function CreateProjectDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  /** Runs after the project exists, instead of just closing. */
  onCreated?: (project: Project) => void;
}) {
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
      { onSuccess: (project) => (onCreated ? onCreated(project) : onClose()) },
    );
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-[16px]">
          <DialogHeader>
            <DialogTitle>New project</DialogTitle>
            <DialogDescription>A project holds workflows and a folder on disk.</DialogDescription>
          </DialogHeader>
          <div className={FIELD}>
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
          <div className={FIELD}>
            <Label htmlFor="project-folder">Folder path (optional)</Label>
            <Input
              id="project-folder"
              className="font-machine text-[12px]"
              value={folderPath}
              onChange={(e) => setFolderPath(e.target.value)}
              aria-invalid={pathError ? true : undefined}
              placeholder="created if missing"
            />
            {pathError && (
              <p role="alert" className={ERROR_LINE}>
                {pathError}
              </p>
            )}
            {error && !pathError && (
              <p role="alert" className={ERROR_LINE}>
                {error.message}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose}>
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

export function RenameProjectDialog({
  project,
  onClose,
}: {
  project: Project;
  onClose: () => void;
}) {
  const update = useUpdateProject();
  const [name, setName] = useState(project.name);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    update.mutate({ id: project.id, name: name.trim() }, { onSuccess: onClose });
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-[16px]">
          <DialogHeader>
            <DialogTitle>Rename project</DialogTitle>
          </DialogHeader>
          <div className={FIELD}>
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
            <p role="alert" className={ERROR_LINE}>
              {update.error.message}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose}>
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

export function DeleteProjectDialog({
  project,
  onClose,
  onDeleted,
}: {
  project: Project;
  onClose: () => void;
  /** Runs after the delete succeeds (e.g. leave the deleted project), instead of just closing. */
  onDeleted?: () => void;
}) {
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
          <p role="alert" className={ERROR_LINE}>
            {remove.error.message}
          </p>
        )}
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={remove.isPending}
            onClick={() =>
              remove.mutate(project.id, { onSuccess: () => (onDeleted ? onDeleted() : onClose()) })
            }
          >
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
