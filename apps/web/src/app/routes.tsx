import type { RouteObject } from 'react-router-dom';

import { BenchPage } from '../bench/BenchPage';
import { DomainPage } from '../domain/DomainPage';
import { HelpPage } from '../help/HelpPage';
import { KnowledgeBasePage } from '../knowledge/KnowledgeBasePage';
import { KnowledgeListPage } from '../knowledge/KnowledgeListPage';
import { OnboardingPage } from '../onboarding/OnboardingPage';
import { UsagePage } from '../usage/UsagePage';
import { ProjectPage } from '../projects/ProjectPage';
import { ProjectsPage } from '../projects/ProjectsPage';
import { ForgePage } from '../forge/ForgePage';
import { GuardrailsPage } from '../guardrails/GuardrailsPage';
import { ProvidersPage } from '../providers/ProvidersPage';
import { ProjectRunsPage } from '../runs/ProjectRunsPage';
import { RunDetailPage } from '../runs/RunDetailPage';
import { RunComparePage } from '../runs/compare/RunComparePage';
import { SettingsPage } from '../settings/SettingsPage';
import { ToolsLibraryPage } from '../library/ToolsLibraryPage';
import { TimelinePage } from '../timeline/TimelinePage';
import { WorkflowLayout } from '../workflows/WorkflowLayout';
import { WorkflowPage } from '../workflows/WorkflowPage';
import { HomeRedirect } from './HomeRedirect';
import { AppShell } from './layout/AppShell';

/**
 * Routes (Arch §33.3): `/`, `/onboarding`, `/projects`, `/projects/:id`, the Canvas, knowledge,
 * runs, `/providers`, `/guardrails`, `/usage` (D239), `/settings`, and `/help/:page` (D240).
 */
export const routes: RouteObject[] = [
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <HomeRedirect /> },
      { path: 'onboarding', element: <OnboardingPage /> },
      { path: 'projects', element: <ProjectsPage /> },
      { path: 'projects/:projectId', element: <ProjectPage /> },
      {
        path: 'projects/:projectId/workflows/:workflowId',
        element: <WorkflowLayout />,
        children: [
          { index: true, element: <WorkflowPage /> },
          { path: 'forge', element: <ForgePage /> },
          // Domain (D303, D354): the run as its team's conversation, inside the workflow layout so
          // the sockets, the run overlay and the chat socket outlive a switch; the layout hides its
          // chat column here and Domain shows its own Team aside. ?run= and ?node= pick run and lens.
          { path: 'domain', element: <DomainPage /> },
        ],
      },
      {
        path: 'projects/:projectId/workflows/:workflowId/timeline',
        element: <TimelinePage />,
      },
      { path: 'projects/:projectId/runs', element: <ProjectRunsPage /> },
      { path: 'projects/:projectId/knowledge', element: <KnowledgeListPage /> },
      { path: 'knowledge/:kbId', element: <KnowledgeBasePage /> },
      // PG-5.4: two runs side by side, `?a=&b=`; ranked above `runs/:runId` as a static segment.
      { path: 'runs/compare', element: <RunComparePage /> },
      { path: 'runs/:runId', element: <RunDetailPage /> },
      { path: 'providers', element: <ProvidersPage /> },
      { path: 'guardrails', element: <GuardrailsPage /> },
      { path: 'library/tools', element: <ToolsLibraryPage /> },
      { path: 'usage', element: <UsagePage /> },
      // PG-5.6: ACE Bench (Arch §33.3). Its runs open from here only (FR-BEN-008).
      { path: 'bench', element: <BenchPage /> },
      { path: 'bench/experiments/:experimentId', element: <BenchPage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: 'help/:page', element: <HelpPage /> },
    ],
  },
];
