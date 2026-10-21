import type { Project } from '@ace/contracts';
import { Icons, cn } from '@ace/ui';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

import { QueryError } from '../app/QueryError';
import { workflowPath, type WorkflowMode } from '../forge/mode';
import { useProviders } from '../providers/hooks';
import { useSocketStatus } from '../runs/hooks';
import { useCreateWorkflow } from '../workflows/hooks';
import { HomeHeader } from './HomeHeader';
import { ProjectCard } from './ProjectCard';
import { CreateProjectDialog } from './ProjectDialogs';
import { useOpenProject, useProjects } from './hooks';
import { useProjectSummaries } from './useProjectSummaries';

/** Where a new project opens: Canvas → Ideate, Forge → Forge, Team → Domain (PG-3.7). */
type EntryMode = WorkflowMode;

/** The hero's three entry cards (`Ace Home.dc.html`); class strings are literal for Tailwind. */
const ENTRIES: ReadonlyArray<{
  mode: EntryMode;
  icon: string;
  title: string;
  sub: string;
  accent: string;
  tile: string;
}> = [
  {
    mode: 'ideate',
    icon: '◇',
    title: 'Canvas',
    sub: 'Sketch, plan and arrange visually',
    accent: 'hover:border-[#ef6b3f] focus-visible:border-[#ef6b3f]',
    tile: 'bg-[#ef6b3f1f] text-[#ef6b3f]',
  },
  {
    mode: 'forge',
    icon: '</>',
    title: 'Forge',
    sub: 'Code editor — build and ship',
    accent: 'hover:border-[#5b7fe0] focus-visible:border-[#5b7fe0]',
    tile: 'bg-[#5b7fe01f] text-[#5b7fe0]',
  },
  {
    mode: 'domain',
    icon: '@',
    title: 'Domain',
    sub: 'Give a team a goal and talk to it',
    accent: 'hover:border-[#7a62d6] focus-visible:border-[#7a62d6]',
    tile: 'bg-[#7a62d61f] text-[#7a62d6]',
  },
];

/** One muted 13px line: Home's empty and loading states (spec §8). */
const MUTED_LINE = 'text-center text-[13px] text-[var(--muted)]';

/** "Agents ready" (D337): the engine socket is open and at least one provider is CONNECTED. */
function useAgentsReady(): boolean {
  const socket = useSocketStatus();
  const providers = useProviders();
  return (
    socket === 'open' && (providers.data ?? []).some((provider) => provider.status === 'CONNECTED')
  );
}

/**
 * `/projects` — the theme's Home (D337, FR-PRJ-001/004): the hero, whose Canvas and Forge cards
 * create a project with a first workflow and open it in Ideate or Forge, and Recent, one card per
 * project. Rename and delete live in the workspace's "…" menu (D331).
 */
export function ProjectsPage() {
  const projects = useProjects();
  const summaries = useProjectSummaries(projects.data);
  const ready = useAgentsReady();
  const navigate = useNavigate();
  const { mutate: openProject } = useOpenProject();
  const [filter, setFilter] = useState<'all' | 'live'>('all');
  const [dialogMode, setDialogMode] = useState<EntryMode>();
  const [starting, setStarting] = useState<{ project: Project; mode: EntryMode }>();
  const { mutate: createFirstWorkflow } = useCreateWorkflow(starting?.project.id ?? '');
  const startedFor = useRef<string>();

  /** Record the project as the last one opened (FR-PRJ-004, TC-PRJ-004), then go to `path`. */
  const openAt = (projectId: string, path: string) =>
    openProject(projectId, { onSettled: () => navigate(path) });

  /*
   * A new project's first workflow, named after it. `useCreateWorkflow` is bound to a project id,
   * which only exists once the dialog has created the project — so this runs on the render after.
   * If the workflow cannot be made, the project page opens instead.
   */
  useEffect(() => {
    if (!starting || startedFor.current === starting.project.id) return;
    startedFor.current = starting.project.id;
    const { project, mode } = starting;
    const go = (path: string) => openProject(project.id, { onSettled: () => navigate(path) });
    createFirstWorkflow(project.name, {
      onSuccess: (workflow) => go(workflowPath(project.id, workflow.id, mode)),
      onError: () => go(`/projects/${project.id}`),
    });
  }, [starting, createFirstWorkflow, openProject, navigate]);

  // Recent is newest first, as the theme lists it: by last activity once a project's summary is in,
  // by its own opened/updated time until then, so cards don't jump about while summaries load.
  const activity = (project: Project): number =>
    summaries.get(project.id)?.lastActivity ??
    Math.max(Date.parse(project.updatedAt), Date.parse(project.lastOpenedAt ?? '') || 0);
  const all = [...(projects.data ?? [])].sort((a, b) => activity(b) - activity(a));
  const live = all.filter((project) => summaries.get(project.id)?.live === true);
  const liveKnown =
    projects.data !== undefined &&
    all.every((project) => summaries.get(project.id)?.live !== undefined);
  const shown = filter === 'all' ? all : live;

  let recent: ReactNode;
  if (projects.isPending) recent = <p className={MUTED_LINE}>Loading projects…</p>;
  else if (projects.isError)
    recent = (
      <QueryError
        what="projects"
        error={projects.error}
        onRetry={() => void projects.refetch()}
        className="items-center text-center"
      />
    );
  else if (all.length === 0) recent = <p className={MUTED_LINE}>No projects yet</p>;
  else if (shown.length === 0) recent = <p className={MUTED_LINE}>No live projects</p>;
  else
    recent = (
      <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-[18px]">
        {shown.map((project) => (
          <ProjectCard
            key={project.id}
            project={project}
            summary={summaries.get(project.id)}
            onOpen={() => openAt(project.id, `/projects/${project.id}`)}
            onOpenMode={(path) => openAt(project.id, path)}
          />
        ))}
      </div>
    );

  return (
    // line-height `normal`, as in the theme file (Tailwind's preflight sets 1.5).
    <div
      data-surface="home"
      className="min-h-full bg-[image:var(--page)] leading-[normal] text-[var(--ink)]"
    >
      <HomeHeader />
      <main className="mx-auto max-w-[960px] px-[24px]">
        <section className="relative flex min-h-[calc(64vh_-_44px)] flex-col items-center justify-center pb-[36px] pt-[56px]">
          <div
            aria-hidden
            className="pointer-events-none absolute left-1/2 top-[44%] h-[360px] w-[720px] max-w-full bg-[radial-gradient(closest-side,var(--glow),rgba(239,107,63,0)_100%)] [transform:translate(-50%,-50%)]"
          />
          {ready && (
            <div className="relative mb-[22px] flex h-[26px] shrink-0 items-center gap-[8px] whitespace-nowrap rounded-full border border-[var(--line)] bg-[var(--soft)] pl-[8px] pr-[12px] text-[11px] text-[var(--muted)]">
              <span
                aria-hidden
                className="h-[8px] w-[8px] rounded-full bg-[#ef6b3f] shadow-[0_0_0_3px_rgba(239,107,63,0.18)]"
              />
              Agents ready
            </div>
          )}
          <h1 className="relative mb-[12px] text-balance text-center text-[length:clamp(32px,5vw,48px)] font-semibold leading-[1.05] tracking-[-0.04em]">
            What would you like to make?
          </h1>
          <p className="relative mb-[34px] text-pretty text-center text-[14px] text-[var(--muted)]">
            Describe it once — Ace assembles the team and gets to work.
          </p>
          <div className="relative grid w-full max-w-[860px] grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-[16px]">
            {ENTRIES.map((entry) => (
              <button
                key={entry.mode}
                type="button"
                onClick={() => setDialogMode(entry.mode)}
                className={cn(
                  'flex w-full cursor-pointer items-center gap-[16px] rounded-[18px] border border-[var(--line)] bg-[var(--surface)] px-[20px] py-[18px] text-left text-[var(--ink)] shadow-[0_0_0_6px_var(--ring6),0_20px_50px_-24px_rgba(80,45,25,0.25)] outline-none [transition:transform_.2s,border-color_.2s] hover:[transform:translateY(-2px)]',
                  entry.accent,
                )}
              >
                <div
                  aria-hidden
                  className={cn(
                    'flex h-[46px] w-[46px] shrink-0 items-center justify-center rounded-[13px] font-machine text-[20px] font-bold',
                    entry.tile,
                  )}
                >
                  {entry.icon}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[16px] font-semibold tracking-[-0.01em]">{entry.title}</div>
                  <div className="mt-[3px] text-[12px] text-[var(--muted)]">{entry.sub}</div>
                </div>
                <div aria-hidden className="text-[16px] text-[var(--muted)]">
                  <Icons.ArrowRight aria-hidden size={12} />
                </div>
              </button>
            ))}
          </div>
        </section>

        <section className="pb-[80px]">
          <div className="mb-[14px] flex items-center gap-[6px]">
            <h2 className="mr-[8px] text-[13px] font-semibold tracking-[-0.01em]">Recent</h2>
            <FilterPill active={filter === 'all'} onClick={() => setFilter('all')}>
              {projects.data === undefined ? 'All' : `All ${all.length}`}
            </FilterPill>
            <FilterPill active={filter === 'live'} onClick={() => setFilter('live')}>
              {liveKnown ? `Live ${live.length}` : 'Live'}
            </FilterPill>
          </div>
          {recent}
        </section>
      </main>

      {dialogMode && (
        <CreateProjectDialog
          onClose={() => setDialogMode(undefined)}
          onCreated={(project) => {
            setDialogMode(undefined);
            setStarting({ project, mode: dialogMode });
          }}
        />
      )}
    </div>
  );
}

/** Recent's All / Live pill: the segmented colours when active, the off colours otherwise. */
function FilterPill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'h-[24px] shrink-0 cursor-pointer whitespace-nowrap rounded-full border px-[11px] text-[9px] font-semibold outline-none focus-visible:shadow-[0_0_0_2px_#ef6b3f]',
        active
          ? 'border-[var(--seg)] bg-[var(--seg)] text-[var(--segInk)]'
          : 'border-[var(--pillOffLine)] bg-[var(--pillOff)] text-[var(--pillOffInk)]',
      )}
    >
      {children}
    </button>
  );
}
