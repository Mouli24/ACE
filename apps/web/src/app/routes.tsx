import type { RouteObject } from 'react-router-dom';

import { ProjectPage } from '../projects/ProjectPage';
import { ProjectsPage } from '../projects/ProjectsPage';
import { SettingsPage } from '../settings/SettingsPage';
import { WorkflowPage } from '../workflows/WorkflowPage';
import { HomeRedirect } from './HomeRedirect';
import { AppShell } from './layout/AppShell';

/** Round 1 routes (Arch §33.3): `/`, `/projects`, `/projects/:id`, the Canvas, `/settings`. */
export const routes: RouteObject[] = [
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <HomeRedirect /> },
      { path: 'projects', element: <ProjectsPage /> },
      { path: 'projects/:projectId', element: <ProjectPage /> },
      { path: 'projects/:projectId/workflows/:workflowId', element: <WorkflowPage /> },
      { path: 'settings', element: <SettingsPage /> },
    ],
  },
];
