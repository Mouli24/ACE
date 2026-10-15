import type { CreateProjectRequest, Project, UpdateProjectRequest } from '@ace/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '../app/api';
import { allPages } from '../lib/pages';
import { queryKeys } from '../workflows/query-keys';

/**
 * Every project, across every page (D-101): `GET /projects` answers 50 a page, oldest first, so
 * reading only the first page hid the newest projects from Home, Guardrails and the home redirect.
 */
export function useProjects() {
  return useQuery({
    queryKey: queryKeys.projects(),
    queryFn: () =>
      allPages((cursor) => api().listProjects(cursor === undefined ? {} : { cursor })),
  });
}

export function useProject(projectId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.project(projectId ?? ''),
    queryFn: () => api().getProject(projectId ?? ''),
    enabled: Boolean(projectId),
  });
}

function useProjectsInvalidator() {
  const queryClient = useQueryClient();
  return (project?: Project) => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.projects() });
    if (project) queryClient.setQueryData(queryKeys.project(project.id), project);
  };
}

export function useCreateProject() {
  const done = useProjectsInvalidator();
  return useMutation({
    mutationFn: (body: CreateProjectRequest) => api().createProject(body),
    onSuccess: (project) => done(project),
  });
}

export function useUpdateProject() {
  const done = useProjectsInvalidator();
  return useMutation({
    mutationFn: ({ id, ...body }: UpdateProjectRequest & { id: string }) =>
      api().updateProject(id, body),
    onSuccess: (project) => done(project),
  });
}

export function useDeleteProject() {
  const done = useProjectsInvalidator();
  return useMutation({
    mutationFn: (id: string) => api().deleteProject(id),
    onSuccess: () => done(),
  });
}

/** `POST /projects/:id/open`: marks the last opened project (FR-PRJ-004). */
export function useOpenProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api().openProject(id),
    onSuccess: (project) => {
      queryClient.setQueryData(queryKeys.project(project.id), project);
      void queryClient.invalidateQueries({ queryKey: queryKeys.settings() });
    },
  });
}
