import type { Workflow } from '@ace/contracts';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  cn,
} from '@ace/ui';
import { ChevronDown, Plus } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import {
  CreateWorkflowDialog,
  DeleteWorkflowDialog,
  RenameWorkflowDialog,
} from './WorkflowDialogs';
import { useDuplicateWorkflow, useWorkflows } from './hooks';
import { downloadWorkflowExport } from './export';

type DialogState =
  | { kind: 'create' }
  | { kind: 'rename'; workflow: Workflow }
  | { kind: 'delete'; workflow: Workflow }
  | undefined;

/**
 * Workflow tabs in the top bar (FR-WF-002). Every workflow of the project is a tab; the route
 * decides which one is active, so a reload lands on the same tab.
 */
export function WorkflowTabs({
  projectId,
  activeWorkflowId,
}: {
  projectId: string;
  activeWorkflowId: string | undefined;
}) {
  const workflows = useWorkflows(projectId);
  const duplicate = useDuplicateWorkflow(projectId);
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<DialogState>();

  return (
    <div
      className="flex min-w-0 items-center gap-1 overflow-x-auto"
      role="tablist"
      aria-label="Workflows"
    >
      {workflows.data?.map((workflow) => {
        const active = workflow.id === activeWorkflowId;
        return (
          <div
            key={workflow.id}
            className={cn(
              'flex shrink-0 items-center rounded-md border border-transparent text-sm',
              active ? 'border-border bg-card text-fg' : 'text-fg-muted hover:text-fg',
            )}
          >
            <button
              type="button"
              role="tab"
              aria-selected={active}
              className="max-w-[12rem] truncate px-3 py-1 font-human focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              onClick={() => navigate(`/projects/${projectId}/workflows/${workflow.id}`)}
            >
              {workflow.name}
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="px-1 py-1 text-fg-muted hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  aria-label={`Workflow actions for ${workflow.name}`}
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem onSelect={() => setDialog({ kind: 'rename', workflow })}>
                  Rename
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() =>
                    duplicate.mutate(workflow.id, {
                      onSuccess: (graph) =>
                        navigate(`/projects/${projectId}/workflows/${graph.workflow.id}`),
                    })
                  }
                >
                  Duplicate
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => void downloadWorkflowExport(workflow.id, workflow.name)}
                >
                  Export JSON
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-danger"
                  onSelect={() => setDialog({ kind: 'delete', workflow })}
                >
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        );
      })}
      <Button
        variant="ghost"
        size="sm"
        className="shrink-0"
        onClick={() => setDialog({ kind: 'create' })}
        aria-label="Add workflow"
      >
        <Plus className="h-4 w-4" />
      </Button>

      {dialog?.kind === 'create' && (
        <CreateWorkflowDialog projectId={projectId} onClose={() => setDialog(undefined)} />
      )}
      {dialog?.kind === 'rename' && (
        <RenameWorkflowDialog workflow={dialog.workflow} onClose={() => setDialog(undefined)} />
      )}
      {dialog?.kind === 'delete' && (
        <DeleteWorkflowDialog
          workflow={dialog.workflow}
          isActive={dialog.workflow.id === activeWorkflowId}
          onClose={() => setDialog(undefined)}
        />
      )}
    </div>
  );
}
