import { RUN_ACTIONS, type Project, type RunAction, type Workflow } from '@ace/contracts';
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
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Icons,
  cn,
  toast,
} from '@ace/ui';
import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useShallow } from 'zustand/react/shallow';

import { useWorkflowMode, workflowPath } from '../../forge/mode';
import { DeleteProjectDialog, RenameProjectDialog } from '../../projects/ProjectDialogs';
import { useProject } from '../../projects/hooks';
import { ApprovalsDialog } from '../../runs/approvals/ApprovalsBadge';
import {
  canReplay,
  useApprovals,
  useEndRun,
  usePauseRun,
  useReplayRun,
  useRestartRun,
  useResumeRun,
  useStopRun,
} from '../../runs/hooks';
import { useRunStore } from '../../runs/run-store';
import { useOpenRunInPlace } from '../../runs/useOpenRunInPlace';
import { useStartRunFlow } from '../../runs/useStartRunFlow';
import { useWorkflowImport } from '../../workflows/ImportWorkflowButton';
import {
  CreateWorkflowDialog,
  DeleteWorkflowDialog,
  RenameWorkflowDialog,
} from '../../workflows/WorkflowDialogs';
import { downloadWorkflowExport } from '../../workflows/export';
import { useDuplicateWorkflow, useWorkflows } from '../../workflows/hooks';
import { usePanelsStore } from '../stores/panels';
import { APP_LINKS } from './app-links';

type OpenDialog =
  | { kind: 'create' }
  | { kind: 'rename'; workflow: Workflow }
  | { kind: 'delete'; workflow: Workflow }
  | { kind: 'rename-project'; project: Project }
  | { kind: 'delete-project'; project: Project }
  | { kind: 'approvals'; runId: string }
  | { kind: 'stop'; runId: string }
  | undefined;

const ACTION_LABEL: Readonly<Record<RunAction, string>> = {
  pause: 'Pause',
  resume: 'Resume',
  stop: 'Stop…',
  restart: 'Restart',
  end: 'End',
};

const LINK_ITEM = 'text-[var(--ink)] no-underline hover:text-[var(--ink)]';

/**
 * The canvas breadcrumb's "…" — the workspace menu (D331). It holds what the old top bar carried:
 * the workflows (FR-WF-001..003, 007, 008), the run (FR-EXE-001, FR-CTL-001..004, FR-GRD-013), the
 * workflow panel and the bottom panel, the project's pages and dialogs, and the app's pages.
 */
export function WorkspaceMenu({
  projectId,
  workflowId,
}: {
  projectId: string;
  workflowId: string;
}) {
  const navigate = useNavigate();
  const mode = useWorkflowMode();
  const workflows = useWorkflows(projectId);
  const project = useProject(projectId);
  const duplicate = useDuplicateWorkflow(projectId);
  const [dialog, setDialog] = useState<OpenDialog>();
  const close = () => setDialog(undefined);
  const importer = useWorkflowImport(projectId, {
    onError: (message) => toast.error(message),
    label: 'Import workflow JSON',
  });

  const current = workflows.data?.find((workflow) => workflow.id === workflowId);
  const toIdeate = () => {
    if (mode !== 'ideate') navigate(workflowPath(projectId, workflowId, 'ideate'));
  };
  const openSheet = usePanelsStore((store) => store.openSheet);
  const bottomOpen = usePanelsStore((store) => store.bottomOpen);
  const setBottomTab = usePanelsStore((store) => store.setBottomTab);
  const toggleBottom = usePanelsStore((store) => store.toggleBottom);

  const run = useRunSection(workflowId);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Workspace menu"
            data-testid="workspace-menu"
            className="flex h-6 cursor-pointer items-center rounded-full border border-[var(--line)] bg-[var(--soft)] px-[9px] text-[11px] text-[var(--ink)] focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_#ef6b3f]"
          >
            <Icons.MoreHorizontal aria-hidden size={14} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          collisionPadding={8}
          className="max-h-[var(--radix-dropdown-menu-content-available-height)] w-[240px] overflow-y-auto"
        >
          <DropdownMenuLabel>Workflows</DropdownMenuLabel>
          <DropdownMenuGroup>
            {workflows.data?.map((workflow) => {
              const selected = workflow.id === workflowId;
              return (
                <DropdownMenuItem
                  key={workflow.id}
                  role="menuitemradio"
                  aria-checked={selected}
                  data-testid={`menu-workflow-${workflow.id}`}
                  className={cn(selected && 'bg-[var(--hover)] font-semibold')}
                  onSelect={() => {
                    if (!selected) navigate(workflowPath(projectId, workflow.id, mode ?? 'ideate'));
                  }}
                >
                  <span aria-hidden className="w-3 shrink-0 text-[11px] text-[#e8572e]">
                    {selected && <Icons.Check aria-hidden size={11} strokeWidth={2.4} />}
                  </span>
                  <span className="min-w-0 truncate">{workflow.name}</span>
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuGroup>
          <DropdownMenuItem
            data-testid="menu-new-workflow"
            onSelect={() => setDialog({ kind: 'create' })}
          >
            New workflow…
          </DropdownMenuItem>
          <DropdownMenuItem
            data-testid="menu-import-workflow"
            disabled={importer.pending}
            onSelect={importer.pick}
          >
            Import workflow…
          </DropdownMenuItem>

          <DropdownMenuSeparator />
          <DropdownMenuLabel>This workflow</DropdownMenuLabel>
          <DropdownMenuItem
            data-testid="menu-rename-workflow"
            disabled={!current}
            onSelect={() => current && setDialog({ kind: 'rename', workflow: current })}
          >
            Rename…
          </DropdownMenuItem>
          <DropdownMenuItem
            data-testid="menu-duplicate-workflow"
            disabled={duplicate.isPending}
            onSelect={() =>
              duplicate.mutate(workflowId, {
                onSuccess: (graph) =>
                  navigate(workflowPath(projectId, graph.workflow.id, mode ?? 'ideate')),
                onError: (error) => toast.error(error.message),
              })
            }
          >
            Duplicate
          </DropdownMenuItem>
          <DropdownMenuItem
            data-testid="menu-export-workflow"
            disabled={!current}
            onSelect={() =>
              current &&
              void downloadWorkflowExport(current.id, current.name).catch((error: Error) =>
                toast.error(error.message),
              )
            }
          >
            Export JSON
          </DropdownMenuItem>
          <DropdownMenuItem
            data-testid="menu-delete-workflow"
            destructive
            disabled={!current}
            onSelect={() => current && setDialog({ kind: 'delete', workflow: current })}
          >
            Delete…
          </DropdownMenuItem>

          <DropdownMenuSeparator />
          <DropdownMenuLabel>Run</DropdownMenuLabel>
          {!run.active && (
            <DropdownMenuItem
              data-testid="menu-start-run"
              disabled={run.startPending}
              onSelect={run.start}
            >
              Start run
            </DropdownMenuItem>
          )}
          {run.actions.map((action) => (
            <DropdownMenuItem
              key={action}
              data-testid={`menu-run-${action}`}
              destructive={action === 'stop'}
              disabled={run.busy}
              onSelect={() =>
                action === 'stop' && run.runId !== undefined
                  ? setDialog({ kind: 'stop', runId: run.runId })
                  : run.fire(action)
              }
            >
              {ACTION_LABEL[action]}
            </DropdownMenuItem>
          ))}
          {/* PG-5.4: a finished run plays back from its recording — no provider is called. */}
          {run.canReplay && (
            <DropdownMenuItem
              data-testid="menu-run-replay"
              disabled={run.busy}
              onSelect={run.replay}
            >
              Replay run
            </DropdownMenuItem>
          )}
          {run.runId !== undefined && (
            <MenuLink to={`/runs/compare?a=${run.runId}`} testId="menu-run-compare">
              Compare with…
            </MenuLink>
          )}
          {run.runId !== undefined && run.approvals > 0 && (
            <DropdownMenuItem
              data-testid="menu-approvals"
              onSelect={() =>
                run.runId !== undefined && setDialog({ kind: 'approvals', runId: run.runId })
              }
            >
              Approvals ({run.approvals})…
            </DropdownMenuItem>
          )}
          {run.runId !== undefined && (
            <MenuLink to={`/runs/${run.runId}`} testId="menu-run-details">
              Run details
            </MenuLink>
          )}

          <DropdownMenuSeparator />
          <DropdownMenuLabel>Panels</DropdownMenuLabel>
          <DropdownMenuItem
            data-testid="menu-sheet"
            onSelect={() => {
              toIdeate();
              openSheet('inspect');
            }}
          >
            Workflow panel
          </DropdownMenuItem>
          <DropdownMenuItem
            data-testid="menu-problems"
            onSelect={() => {
              if (mode === 'ideate' && bottomOpen) {
                toggleBottom();
                return;
              }
              toIdeate();
              setBottomTab('validation');
            }}
          >
            Problems & events
          </DropdownMenuItem>
          <MenuLink
            to={`/projects/${projectId}/workflows/${workflowId}/timeline`}
            testId="menu-timeline"
          >
            Timeline
          </MenuLink>

          <DropdownMenuSeparator />
          <DropdownMenuLabel>Project</DropdownMenuLabel>
          <MenuLink to={`/projects/${projectId}`} testId="menu-project-page">
            Project page
          </MenuLink>
          <MenuLink to={`/projects/${projectId}/runs`} testId="menu-project-runs">
            Runs
          </MenuLink>
          <MenuLink to={`/projects/${projectId}/knowledge`} testId="menu-knowledge">
            Knowledge
          </MenuLink>
          <DropdownMenuItem
            data-testid="menu-rename-project"
            disabled={!project.data}
            onSelect={() =>
              project.data && setDialog({ kind: 'rename-project', project: project.data })
            }
          >
            Rename project…
          </DropdownMenuItem>
          <DropdownMenuItem
            data-testid="menu-delete-project"
            destructive
            disabled={!project.data}
            onSelect={() =>
              project.data && setDialog({ kind: 'delete-project', project: project.data })
            }
          >
            Delete project…
          </DropdownMenuItem>

          <DropdownMenuSeparator />
          <DropdownMenuLabel>ACE</DropdownMenuLabel>
          {/* D331: what the old top bar's links and More menu reached — the app's pages (U-7) */}
          {APP_LINKS.map(({ to, label, id }) => (
            <MenuLink key={to} to={to} testId={`menu-${id}`}>
              {label}
            </MenuLink>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {importer.input}
      {run.dialog}
      {dialog?.kind === 'create' && <CreateWorkflowDialog projectId={projectId} onClose={close} />}
      {dialog?.kind === 'rename' && (
        <RenameWorkflowDialog workflow={dialog.workflow} onClose={close} />
      )}
      {dialog?.kind === 'delete' && (
        <DeleteWorkflowDialog workflow={dialog.workflow} isActive onClose={close} />
      )}
      {dialog?.kind === 'rename-project' && (
        <RenameProjectDialog project={dialog.project} onClose={close} />
      )}
      {dialog?.kind === 'delete-project' && (
        <DeleteProjectDialog
          project={dialog.project}
          onClose={close}
          onDeleted={() => {
            close();
            navigate('/projects');
          }}
        />
      )}
      {dialog?.kind === 'approvals' && <ApprovalsDialog runId={dialog.runId} onClose={close} />}
      {dialog?.kind === 'stop' && (
        <StopConfirm
          onCancel={close}
          onStop={() => {
            close();
            run.fire('stop');
          }}
        />
      )}
    </>
  );
}

function MenuLink({ to, testId, children }: { to: string; testId: string; children: ReactNode }) {
  return (
    <DropdownMenuItem asChild data-testid={testId} className={LINK_ITEM}>
      <Link to={to}>{children}</Link>
    </DropdownMenuItem>
  );
}

/**
 * The Run section's state and actions. The controls offered are exactly `Run.allowedActions`
 * (FR-CTL-006); each sends its own mutation, and a restart selects the new run in the same mode
 * (FR-CTL-004, PG-3.5), as the run controls do.
 */
function useRunSection(workflowId: string) {
  const openRun = useOpenRunInPlace();
  const flow = useStartRunFlow(workflowId);
  const run = useRunStore(
    useShallow((store) => {
      const mine = store.workflowId === workflowId;
      return {
        runId: mine ? store.runId : undefined,
        allowedActions: mine ? store.allowedActions : undefined,
        status: mine ? store.status : undefined,
      };
    }),
  );
  const approvals = useApprovals(run.runId);
  const mutations = {
    pause: usePauseRun(),
    resume: useResumeRun(),
    stop: useStopRun(),
    restart: useRestartRun(),
    end: useEndRun(),
  };
  const replayMutation = useReplayRun();
  const busy =
    Object.values(mutations).some((mutation) => mutation.isPending) || replayMutation.isPending;
  const allowed = new Set<RunAction>(run.allowedActions ?? []);

  const fire = (action: RunAction) => {
    const runId = run.runId;
    if (runId === undefined) return;
    mutations[action].mutate(runId, {
      onSuccess: (result) => {
        // PG-3.5 (D360): restart keeps the mode; the new run becomes the selected one.
        if (action === 'restart' && result.id !== runId) openRun(result.id);
      },
      onError: (error) => toast.error(error.message),
    });
  };

  return {
    runId: run.runId,
    active: flow.active,
    start: flow.start,
    startPending: flow.pending,
    dialog: flow.dialog,
    actions: run.runId === undefined ? [] : RUN_ACTIONS.filter((action) => allowed.has(action)),
    canReplay: run.runId !== undefined && canReplay(run.status),
    replay: () => {
      const runId = run.runId;
      if (runId === undefined) return;
      replayMutation.mutate(runId, {
        // The replay becomes the selected run, in the same mode (as a restart does, PG-3.5).
        onSuccess: (result) => openRun(result.id),
        onError: (error) => toast.error(error.message),
      });
    },
    approvals: approvals.data?.length ?? 0,
    busy,
    fire,
  };
}

/** Stop asks first, in the run controls' words: it cancels calls in flight (FR-CTL-003). */
export function StopConfirm({ onCancel, onStop }: { onCancel: () => void; onStop: () => void }) {
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <div className="flex flex-col gap-4" data-testid="stop-confirm">
          <DialogHeader>
            <DialogTitle>Stop this run?</DialogTitle>
            <DialogDescription>
              Calls in flight are cancelled, the nodes running now become stopped, and the run
              halts. Nothing already recorded is lost, and you can restart afterwards.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={onCancel}>
              Keep running
            </Button>
            <Button variant="destructive" data-testid="stop-confirm-stop" onClick={onStop}>
              Stop the run
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
