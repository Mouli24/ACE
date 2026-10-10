import {
  BarChart3,
  CircleHelp,
  MessageSquare,
  MoreHorizontal,
  PanelRight,
  Plus,
  Settings,
  ShieldCheck,
} from 'lucide-react';
import { Link, useParams } from 'react-router-dom';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  cn,
} from '@ace/ui';
import { useWorkflowMode } from '../../forge/mode';
import { useProject } from '../../projects/hooks';
import { ProviderStatusBar } from '../../providers/ProviderStatusBar';
import { CompactMenu } from '../../responsive/CompactMenu';
import { useIsCompact } from '../../responsive/useIsCompact';
import { RunBar } from '../../runs/RunBar';
import { ApprovalsBadge } from '../../runs/approvals/ApprovalsBadge';
import { useRunStore } from '../../runs/run-store';
import { DayTotalsChip } from '../../usage/DayTotalsChip';
import { SHEET_ID } from '../../workflows/WorkflowSheet';
import { WorkflowTabs } from '../../workflows/WorkflowTabs';
import { useLayoutStore } from '../stores/layout';
import { usePanelsStore } from '../stores/panels';
import { ModeSwitch } from './ModeSwitch';
import { SHORTCUTS, shortcutLabel } from '../shortcuts';

/** Usage, Guardrail policies, Settings and Help: an icon row at xl and up, the More menu below. */
const LINKS = [
  { to: '/usage', label: 'Usage', Icon: BarChart3 },
  { to: '/guardrails', label: 'Guardrail policies', Icon: ShieldCheck },
  { to: '/settings', label: 'Settings', Icon: Settings },
  { to: '/help/getting-started', label: 'Help', Icon: CircleHelp },
] as const;

const ICON_BUTTON =
  'grid h-8 w-8 place-items-center rounded-chip text-fg-muted hover:bg-border hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent';

/**
 * Top bar: project name, workflow tabs, the Ideate | Forge switch (D299, New node and the workflow
 * panel toggle belong to Ideate), a chat toggle, live provider status (FR-PRV-004), and — on a Canvas — the
 * run controls with the run's status and totals (FR-EXE-001, FR-OBS-002, FR-CTL-001..004), plus a
 * count of the approvals waiting on a person (FR-GRD-013).
 *
 * At phone width (FR-MOB-001) the links and status chips fold into one menu, the approvals badge
 * stays in sight (FR-MOB-002), and the run bar gets a row of its own.
 */
export function TopBar() {
  const { projectId, workflowId } = useParams();
  const project = useProject(projectId);
  const runId = useRunStore((store) => store.runId);
  const compact = useIsCompact();
  const sheetOpen = usePanelsStore((store) => store.sheetOpen);
  const openSheet = usePanelsStore((store) => store.openSheet);
  const closeSheet = usePanelsStore((store) => store.closeSheet);
  const openNewNode = usePanelsStore((store) => store.openNewNode);
  const mode = useWorkflowMode();
  const chatOpen = useLayoutStore((store) => store.chatOpen);
  const toggleChat = useLayoutStore((store) => store.toggleChat);

  if (compact) {
    return (
      <header
        className="flex shrink-0 flex-col border-b border-border bg-panel"
        data-testid="topbar-compact"
      >
        <div className="flex h-12 min-w-0 items-center gap-2 px-3">
          <Link
            to="/projects"
            className="shrink-0 font-human text-base font-semibold tracking-tight"
          >
            ACE
          </Link>
          {project.data && (
            <>
              <span className="text-fg-muted">/</span>
              <Link
                to={`/projects/${project.data.id}`}
                className="min-w-0 truncate font-human text-sm"
                data-testid="project-name"
              >
                {project.data.name}
              </Link>
            </>
          )}
          <div className="flex-1" />
          <ApprovalsBadge runId={runId} />
          <CompactMenu
            {...(projectId === undefined ? {} : { projectId })}
            status={
              <>
                <ProviderStatusBar />
                <DayTotalsChip />
              </>
            }
          />
        </div>
        {workflowId && (
          <div className="flex min-w-0 items-center gap-2 overflow-x-auto px-3 pb-2">
            {projectId && <ModeSwitch projectId={projectId} workflowId={workflowId} />}
            <RunBar workflowId={workflowId} />
          </div>
        )}
      </header>
    );
  }

  return (
    /*
     * Below xl (1280 px) the bar condenses rather than push the page sideways: the workflow tabs
     * give way first (they scroll), provider chips become dots, the four links fold into More, and
     * below lg New node keeps only its + and "/ project" folds away. Run, the run chip and New node
     * never leave the bar.
     */
    <header className="flex h-[52px] min-w-0 shrink-0 items-center gap-1.5 border-b border-border bg-panel pl-[18px] pr-3.5 lg:gap-2 xl:gap-3.5">
      <div className="flex min-w-0 shrink-0 items-baseline gap-2">
        <Link
          to="/projects"
          className="font-human text-xl font-semibold tracking-[-0.01em] text-fg"
        >
          ACE
        </Link>
        {project.data && (
          // on a Canvas below lg the run controls need the room; ACE and the tabs remain
          <span className={cn('items-baseline gap-2', workflowId ? 'hidden lg:flex' : 'flex')}>
            <span className="text-fg-faint">/</span>
            <Link
              to={`/projects/${project.data.id}`}
              className="max-w-[7rem] truncate text-[15px] text-fg-soft hover:text-fg xl:max-w-[14rem]"
              data-testid="project-name"
            >
              {project.data.name}
            </Link>
          </span>
        )}
      </div>
      {/* A floor for the tabs: without it every other item keeps its width and the tabs (with
          "Add workflow" and each tab's actions menu) are squeezed to nothing under them. Below xl
          the floor is low and the strip scrolls, so the run controls keep their room. */}
      {projectId && (
        <div className="min-w-16 shrink xl:min-w-40">
          <WorkflowTabs projectId={projectId} activeWorkflowId={workflowId} />
        </div>
      )}
      {projectId && workflowId && <ModeSwitch projectId={projectId} workflowId={workflowId} />}
      <div className="flex-1" />
      <ProviderStatusBar />
      {/* On a Canvas the run bar already shows this run's totals; the day's wait for a wide screen. */}
      <div className={workflowId ? 'hidden shrink-0 2xl:flex' : 'flex shrink-0'}>
        <DayTotalsChip />
      </div>
      <div aria-hidden className="h-[22px] w-px shrink-0 bg-border" />
      {workflowId && <RunBar workflowId={workflowId} haltInline={false} />}
      <div className="flex shrink-0 items-center gap-0.5">
        <ApprovalsBadge runId={runId} />
        {workflowId && mode !== undefined && (
          <button
            type="button"
            data-testid="chat-toggle"
            aria-label="Chat"
            aria-pressed={chatOpen}
            title={`Chat (${shortcutLabel(SHORTCUTS.toggleChat)})`}
            className={cn(ICON_BUTTON, chatOpen && 'bg-border text-fg')}
            onClick={toggleChat}
          >
            <MessageSquare className="h-4 w-4" aria-hidden />
          </button>
        )}
        {workflowId && mode === 'ideate' && (
          <button
            type="button"
            data-testid="sheet-toggle"
            aria-label="Workflow panel"
            aria-pressed={sheetOpen}
            aria-controls={SHEET_ID}
            title="Workflow panel"
            className={cn(ICON_BUTTON, sheetOpen && 'bg-border text-fg')}
            onClick={() => (sheetOpen ? closeSheet() : openSheet())}
          >
            <PanelRight className="h-4 w-4" aria-hidden />
          </button>
        )}
        <div className="hidden items-center gap-0.5 xl:flex">
          {LINKS.map(({ to, label, Icon }) => (
            <Link key={to} to={to} aria-label={label} className={ICON_BUTTON}>
              <Icon className="h-4 w-4" aria-hidden />
            </Link>
          ))}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="More"
              title="More"
              data-testid="topbar-more"
              className={cn(ICON_BUTTON, 'xl:hidden')}
            >
              <MoreHorizontal className="h-4 w-4" aria-hidden />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            {LINKS.map(({ to, label, Icon }) => (
              <DropdownMenuItem key={to} asChild className="gap-2">
                <Link to={to}>
                  <Icon className="h-4 w-4" aria-hidden />
                  {label}
                </Link>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {workflowId && mode === 'ideate' && (
        <button
          type="button"
          data-testid="new-node-button"
          title="New node"
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-chip border border-border-strong bg-card px-2 font-machine text-[10.5px] uppercase tracking-[0.1em] text-fg hover:bg-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent lg:pl-[11px] lg:pr-3.5"
          onClick={openNewNode}
        >
          <Plus className="h-3.5 w-3.5" aria-hidden />
          <span className="max-lg:sr-only">New node</span>
        </button>
      )}
    </header>
  );
}
