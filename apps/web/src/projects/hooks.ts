import type {
  CloneProjectRequest,
  CreateProjectRequest,
  Project,
  UpdateProjectRequest,
} from '@ace/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '../app/api';
import { queryKeys } from '../workflows/query-keys';

export function useProjects() {
  return useQuery({
    queryKey: queryKeys.projects(),
    queryFn: async () => (await api().listProjects()).items,
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

/** `POST /projects/clone` — a new project in a clone of a GitHub repository (D276). */
export function useCloneProject() {
  const done = useProjectsInvalidator();
  return useMutation({
    mutationFn: (body: CloneProjectRequest) => api().cloneProject(body),
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
