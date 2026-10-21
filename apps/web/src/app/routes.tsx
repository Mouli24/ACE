import type { RouteObject } from 'react-router-dom';

import { HelpPage } from '../help/HelpPage';
import { ProjectPage } from '../projects/ProjectPage';
import { ProjectsPage } from '../projects/ProjectsPage';
import { ProvidersPage } from '../providers/ProvidersPage';
import { ProjectRunsPage } from '../runs/ProjectRunsPage';
import { SettingsPage } from '../settings/SettingsPage';
import { ToolsLibraryPage } from '../library/ToolsLibraryPage';
import { WorkflowLayout } from '../workflows/WorkflowLayout';
import { WorkflowPage } from '../workflows/WorkflowPage';
import { HomeRedirect } from './HomeRedirect';
import { lazyPage } from './lazy-page';
import { AppShell } from './layout/AppShell';
import { NotFound, RouteError } from './RouteError';

/*
 * Audit U-8: the screens most sessions never open are their own chunks — Forge, Domain, Bench, a
 * run's page and the compare view, Usage, Guardrails, Knowledge, the setup wizard and the
 * timeline. Each loads on its first visit, or before through `preloadRoutes` (main.tsx calls it
 * once the first screen is up). The Canvas and the pages around it stay in the main chunk.
 */
const Forge = lazyPage(() => import('../forge/ForgePage').then((m) => m.ForgePage));
const Domain = lazyPage(() => import('../domain/DomainRoute').then((m) => m.DomainPage));
const Bench = lazyPage(() => import('../bench/BenchPage').then((m) => m.BenchPage));
const RunDetail = lazyPage(() => import('../runs/RunDetailPage').then((m) => m.RunDetailPage));
const RunCompare = lazyPage(() =>
  import('../runs/compare/RunComparePage').then((m) => m.RunComparePage),
);
const Usage = lazyPage(() => import('../usage/UsagePage').then((m) => m.UsagePage));
const Guardrails = lazyPage(() =>
  import('../guardrails/GuardrailsPage').then((m) => m.GuardrailsPage),
);
const KnowledgeList = lazyPage(() =>
  import('../knowledge/KnowledgeListPage').then((m) => m.KnowledgeListPage),
);
const KnowledgeBase = lazyPage(() =>
  import('../knowledge/KnowledgeBasePage').then((m) => m.KnowledgeBasePage),
);
const Onboarding = lazyPage(() =>
  import('../onboarding/OnboardingPage').then((m) => m.OnboardingPage),
);
const Timeline = lazyPage(() => import('../timeline/TimelinePage').then((m) => m.TimelinePage));

const LAZY_PAGES = [
  Forge,
  Domain,
  Bench,
  RunDetail,
  RunCompare,
  Usage,
  Guardrails,
  KnowledgeList,
  KnowledgeBase,
  Onboarding,
  Timeline,
];

/** Fetch every split-off screen now, so opening one later does not wait (tests render at once). */
export function preloadRoutes(): Promise<void> {
  return Promise.all(LAZY_PAGES.map((page) => page.preload())).then(() => undefined);
}

/**
 * Routes (Arch §33.3): `/`, `/onboarding`, `/projects`, `/projects/:id`, the Canvas, knowledge,
 * runs, `/providers`, `/guardrails`, `/usage` (D239), `/settings`, and `/help/:page` (D240).
 *
 * Audit U-1: every screen sits in one pathless route whose `errorElement` draws inside the shell,
 * so a screen that throws keeps the header; the workflow route has its own, so a Canvas crash keeps
 * the workspace header and footer; `*` is a real "not found" page. The shell's own `errorElement`
 * is the last resort, with no chrome left to keep.
 */
export const routes: RouteObject[] = [
  {
    path: '/',
    element: <AppShell />,
    errorElement: <RouteError standalone />,
    children: [
      {
        errorElement: <RouteError />,
        children: [
          { index: true, element: <HomeRedirect /> },
          { path: 'onboarding', element: <Onboarding.Page /> },
          { path: 'projects', element: <ProjectsPage /> },
          { path: 'projects/:projectId', element: <ProjectPage /> },
          {
            path: 'projects/:projectId/workflows/:workflowId',
            element: <WorkflowLayout />,
            errorElement: <RouteError />,
            children: [
              { index: true, element: <WorkflowPage /> },
              { path: 'forge', element: <Forge.Page /> },
              // Domain (D303, D354): the run as its team's conversation, inside the workflow layout
              // so the sockets, the run overlay and the chat socket outlive a switch; the layout
              // hides its chat column here and Domain shows its own Team aside. ?run= and ?node=
              // pick run and lens.
              { path: 'domain', element: <Domain.Page /> },
            ],
          },
          {
            path: 'projects/:projectId/workflows/:workflowId/timeline',
            element: <Timeline.Page />,
          },
          { path: 'projects/:projectId/runs', element: <ProjectRunsPage /> },
          { path: 'projects/:projectId/knowledge', element: <KnowledgeList.Page /> },
          { path: 'knowledge/:kbId', element: <KnowledgeBase.Page /> },
          // PG-5.4: two runs side by side, `?a=&b=`; ranked above `runs/:runId` as a static segment.
          { path: 'runs/compare', element: <RunCompare.Page /> },
          { path: 'runs/:runId', element: <RunDetail.Page /> },
          { path: 'providers', element: <ProvidersPage /> },
          { path: 'guardrails', element: <Guardrails.Page /> },
          { path: 'library/tools', element: <ToolsLibraryPage /> },
          { path: 'usage', element: <Usage.Page /> },
          // PG-5.6: ACE Bench (Arch §33.3). Its runs open from here only (FR-BEN-008).
          { path: 'bench', element: <Bench.Page /> },
          { path: 'bench/experiments/:experimentId', element: <Bench.Page /> },
          { path: 'settings', element: <SettingsPage /> },
          { path: 'help/:page', element: <HelpPage /> },
          { path: '*', element: <NotFound /> },
        ],
      },
    ],
  },
];
