import { Navigate } from 'react-router-dom';

import { useProjects } from '../projects/hooks';
import { useSettings } from '../settings/hooks';

/**
 * `/` → the last opened project (FR-PRJ-004), else the project list (Arch §33.3) — except for a
 * brand-new user, who has finished no onboarding and has no project yet: they go to the first-run
 * wizard (FR-ONB-001, Arch §33.1 step 2). Anyone with a project, or who finished or skipped the
 * wizard, keeps the old behaviour.
 */
export function HomeRedirect() {
  const settings = useSettings();
  const projects = useProjects();
  if (settings.isPending || projects.isPending) {
    return <p className="p-6 text-center text-[13px] text-[var(--muted)]">Opening ACE…</p>;
  }
  const last = settings.data?.lastProjectId;
  if (last) return <Navigate to={`/projects/${last}`} replace />;
  const fresh = settings.data?.onboardingCompleted === false && (projects.data?.length ?? 0) === 0;
  return <Navigate to={fresh ? '/onboarding' : '/projects'} replace />;
}
