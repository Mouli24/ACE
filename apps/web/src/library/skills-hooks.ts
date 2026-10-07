import type {
  Bundle,
  BundleFile,
  CreateSkillRequest,
  Id,
  Skill,
  UpdateSkillRequest,
} from '@ace/contracts';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { api } from '../app/api';

/**
 * Engine data for the Skills and Bundles tabs and the agent's Skills section (ACE parity P1, D272,
 * D273). Skills and bundles are their own query keys; a bundle import or delete adds or removes
 * skills too, so it invalidates both.
 */
export const skillQueryKeys = {
  skills: () => ['skills'] as const,
  bundles: () => ['bundles'] as const,
};

/** `GET /skills` → `{ items }`: built-ins first, then the rest by name. */
export function useSkills() {
  return useQuery({
    queryKey: skillQueryKeys.skills(),
    queryFn: async () => (await api().listSkills()).items,
  });
}

/** `GET /bundles` → `{ items }`, oldest first. */
export function useBundles() {
  return useQuery({
    queryKey: skillQueryKeys.bundles(),
    queryFn: async () => (await api().listBundles()).items,
  });
}

function invalidateSkills(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: skillQueryKeys.skills() });
}

function invalidateSkillsAndBundles(queryClient: QueryClient): void {
  invalidateSkills(queryClient);
  void queryClient.invalidateQueries({ queryKey: skillQueryKeys.bundles() });
}

/** `POST /skills` — a `user` skill at version 1; a taken name is 409 `name_taken`. */
export function useCreateSkill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateSkillRequest): Promise<Skill> => api().createSkill(body),
    onSuccess: () => invalidateSkills(queryClient),
  });
}

/** `PATCH /skills/:id` — a built-in is 409 `skill_read_only`. */
export function useUpdateSkill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: Id; body: UpdateSkillRequest }): Promise<Skill> =>
      api().updateSkill(id, body),
    onSuccess: () => invalidateSkills(queryClient),
  });
}

/** `DELETE /skills/:id`. */
export function useDeleteSkill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: Id): Promise<void> => api().deleteSkill(id),
    onSuccess: () => invalidateSkills(queryClient),
  });
}

/** `POST /skills/:id/duplicate` — a `user` copy, the way to change a built-in. */
export function useDuplicateSkill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: Id): Promise<Skill> => api().duplicateSkill(id),
    onSuccess: () => invalidateSkills(queryClient),
  });
}

/** `POST /bundles/import` — installs the bundle's skills; connects and enables nothing (D273). */
export function useImportBundle() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (file: BundleFile): Promise<Bundle> => api().importBundle(file),
    onSuccess: () => invalidateSkillsAndBundles(queryClient),
  });
}

/** `DELETE /bundles/:id` — the skills it installed go with it. */
export function useDeleteBundle() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: Id): Promise<void> => api().deleteBundle(id),
    onSuccess: () => invalidateSkillsAndBundles(queryClient),
  });
}
