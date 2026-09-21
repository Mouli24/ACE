import { Navigate } from 'react-router-dom';

import { useSettings } from '../settings/hooks';

/** `/` → the last opened project (FR-PRJ-004), else the project list (Arch §33.3). */
export function HomeRedirect() {
  const settings = useSettings();
  if (settings.isPending) return <p className="p-6 text-fg-muted">Opening ACE…</p>;
  const last = settings.data?.lastProjectId;
  return <Navigate to={last ? `/projects/${last}` : '/projects'} replace />;
}
