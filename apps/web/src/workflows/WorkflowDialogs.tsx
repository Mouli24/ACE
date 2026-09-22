import type { Workflow } from '@ace/contracts';
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
import { useNavigate } from 'react-router-dom';

import { useCreateWorkflow, useDeleteWorkflow, useRenameWorkflow } from './hooks';

function NameDialog({
  title,
  description,
  initial,
  submitLabel,
  pending,
  error,
  onSubmit,
  onClose,
}: {
  title: string;
  description?: string;
  initial: string;
  submitLabel: string;
  pending: boolean;
  error: Error | null;
  onSubmit: (name: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit(name.trim());
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="workflow-name">Name</Label>
            <Input
              id="workflow-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              autoFocus
              required
            />
          </div>
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error.message}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || pending}>
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** FR-WF-001: a new workflow opens as a tab with an empty Canvas. */
export function CreateWorkflowDialog({
  projectId,
  onClose,
}: {
  projectId: string;
  onClose: () => void;
}) {
  const create = useCreateWorkflow(projectId);
  const navigate = useNavigate();
  return (
    <NameDialog
      title="New workflow"
      description="It opens as a tab with an empty Canvas."
      initial=""
      submitLabel="Create"
      pending={create.isPending}
      error={create.error}
      onClose={onClose}
      onSubmit={(name) =>
        create.mutate(name, {
          onSuccess: (workflow) => {
            onClose();
            navigate(`/projects/${projectId}/workflows/${workflow.id}`);
          },
        })
      }
    />
  );
}

export function RenameWorkflowDialog({
  workflow,
  onClose,
}: {
  workflow: Workflow;
  onClose: () => void;
}) {
  const rename = useRenameWorkflow(workflow.projectId);
  return (
    <NameDialog
      title="Rename workflow"
      initial={workflow.name}
      submitLabel="Save"
      pending={rename.isPending}
      error={rename.error}
      onClose={onClose}
      onSubmit={(name) => rename.mutate({ id: workflow.id, name }, { onSuccess: onClose })}
    />
  );
}

export function DeleteWorkflowDialog({
  workflow,
  isActive,
  onClose,
}: {
  workflow: Workflow;
  isActive: boolean;
  onClose: () => void;
}) {
  const remove = useDeleteWorkflow(workflow.projectId);
  const navigate = useNavigate();
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete “{workflow.name}”?</DialogTitle>
          <DialogDescription>
            Its nodes and connections are removed. This cannot be undone.
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
            onClick={() =>
              remove.mutate(workflow.id, {
                onSuccess: () => {
                  onClose();
                  if (isActive) navigate(`/projects/${workflow.projectId}`);
                },
              })
            }
          >
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
