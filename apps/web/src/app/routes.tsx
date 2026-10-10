import type { RouteObject } from 'react-router-dom';

import { DomainPage } from '../domain/DomainPage';
import { HelpPage } from '../help/HelpPage';
import { KnowledgeBasePage } from '../knowledge/KnowledgeBasePage';
import { KnowledgeListPage } from '../knowledge/KnowledgeListPage';
import { OnboardingPage } from '../onboarding/OnboardingPage';
import { UsagePage } from '../usage/UsagePage';
import { ProjectPage } from '../projects/ProjectPage';
import { ProjectsPage } from '../projects/ProjectsPage';
import { GuardrailsPage } from '../guardrails/GuardrailsPage';
import { ProvidersPage } from '../providers/ProvidersPage';
import { ProjectRunsPage } from '../runs/ProjectRunsPage';
import { RunDetailPage } from '../runs/RunDetailPage';
import { SettingsPage } from '../settings/SettingsPage';
import { ToolsLibraryPage } from '../library/ToolsLibraryPage';
import { TimelinePage } from '../timeline/TimelinePage';
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
      { path: 'projects/:projectId/workflows/:workflowId', element: <WorkflowPage /> },
      // Domain (D303): the run as its team's conversation; ?run= and ?node= pick the run and lens.
      { path: 'projects/:projectId/workflows/:workflowId/domain', element: <DomainPage /> },
      {
        path: 'projects/:projectId/workflows/:workflowId/timeline',
        element: <TimelinePage />,
      },
      { path: 'projects/:projectId/runs', element: <ProjectRunsPage /> },
      { path: 'projects/:projectId/knowledge', element: <KnowledgeListPage /> },
      { path: 'knowledge/:kbId', element: <KnowledgeBasePage /> },
      { path: 'runs/:runId', element: <RunDetailPage /> },
      { path: 'providers', element: <ProvidersPage /> },
      { path: 'guardrails', element: <GuardrailsPage /> },
      { path: 'library/tools', element: <ToolsLibraryPage /> },
      { path: 'usage', element: <UsagePage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: 'help/:page', element: <HelpPage /> },
    ],
  },
];
