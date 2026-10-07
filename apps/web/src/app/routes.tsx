import { Navigate, type RouteObject } from 'react-router-dom';

import { HelpPage } from '../help/HelpPage';
import { KnowledgeBasePage } from '../knowledge/KnowledgeBasePage';
import { KnowledgeListPage } from '../knowledge/KnowledgeListPage';
import { OnboardingPage } from '../onboarding/OnboardingPage';
import { UsagePage } from '../usage/UsagePage';
import { ProjectPage } from '../projects/ProjectPage';
import { ProjectSettingsPage } from '../projects/ProjectSettingsPage';
import { ProjectsPage } from '../projects/ProjectsPage';
import { GuardrailsPage } from '../guardrails/GuardrailsPage';
import { ProvidersPage } from '../providers/ProvidersPage';
import { ProjectRunsPage } from '../runs/ProjectRunsPage';
import { RunDetailPage } from '../runs/RunDetailPage';
import { SettingsPage } from '../settings/SettingsPage';
import { NotesPage } from '../suggestions/NotesPage';
import { SuggestionsPage } from '../suggestions/SuggestionsPage';
import { TaskPage } from '../tasks/TaskPage';
import { TasksBoardPage } from '../tasks/TasksBoardPage';
import { LibraryPage } from '../library/LibraryPage';
import { TimelinePage } from '../timeline/TimelinePage';
import { WorkflowPage } from '../workflows/WorkflowPage';
import { HomeRedirect } from './HomeRedirect';
import { AppShell } from './layout/AppShell';

/**
 * Routes (Arch §33.3): `/`, `/onboarding`, `/projects`, `/projects/:id`, the Canvas, knowledge,
 * runs, `/providers`, `/guardrails`, `/usage` (D239), `/settings`, and `/help/:page` (D240). ACE
 * parity P0 adds a project's task board, one task's page and the project's settings; P1 turns
 * `/library/tools` into the Library's tabs (`/library/:tab`: tools, skills, plugins, bundles).
 * ACE parity P2 adds a project's Suggestions and its team Notes.
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
      {
        path: 'projects/:projectId/workflows/:workflowId/timeline',
        element: <TimelinePage />,
      },
      { path: 'projects/:projectId/tasks', element: <TasksBoardPage /> },
      { path: 'projects/:projectId/tasks/:taskId', element: <TaskPage /> },
      { path: 'projects/:projectId/settings', element: <ProjectSettingsPage /> },
      { path: 'projects/:projectId/runs', element: <ProjectRunsPage /> },
      { path: 'projects/:projectId/knowledge', element: <KnowledgeListPage /> },
      { path: 'projects/:projectId/suggestions', element: <SuggestionsPage /> },
      { path: 'projects/:projectId/notes', element: <NotesPage /> },
      { path: 'knowledge/:kbId', element: <KnowledgeBasePage /> },
      { path: 'runs/:runId', element: <RunDetailPage /> },
      { path: 'providers', element: <ProvidersPage /> },
      { path: 'guardrails', element: <GuardrailsPage /> },
      { path: 'library', element: <Navigate to="/library/tools" replace /> },
      { path: 'library/:tab', element: <LibraryPage /> },
      { path: 'usage', element: <UsagePage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: 'help/:page', element: <HelpPage /> },
    ],
  },
];
