import type { RouteObject } from 'react-router-dom';

import { ProjectPage } from '../projects/ProjectPage';
import { ProjectsPage } from '../projects/ProjectsPage';
import { ProvidersPage } from '../providers/ProvidersPage';
import { ProjectRunsPage } from '../runs/ProjectRunsPage';
import { RunDetailPage } from '../runs/RunDetailPage';
import { SettingsPage } from '../settings/SettingsPage';
import { WorkflowPage } from '../workflows/WorkflowPage';
import { HomeRedirect } from './HomeRedirect';
import { AppShell } from './layout/AppShell';

/** Routes (Arch §33.3): `/`, `/projects`, `/projects/:id`, the Canvas, `/providers`, `/settings`. */
export const routes: RouteObject[] = [
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <HomeRedirect /> },
      { path: 'projects', element: <ProjectsPage /> },
      { path: 'projects/:projectId', element: <ProjectPage /> },
      { path: 'projects/:projectId/workflows/:workflowId', element: <WorkflowPage /> },
      { path: 'projects/:projectId/runs', element: <ProjectRunsPage /> },
      { path: 'runs/:runId', element: <RunDetailPage /> },
      { path: 'providers', element: <ProvidersPage /> },
      { path: 'settings', element: <SettingsPage /> },
    ],
  },
];
