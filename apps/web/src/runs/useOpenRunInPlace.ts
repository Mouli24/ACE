import type { Id } from '@ace/contracts';
import { useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

/**
 * PG-3.5 (D360): a restart keeps the person where they are. Inside a workflow — Ideate, Forge or
 * Domain — the new run becomes the selected one (`?run=`) on the same screen; anywhere else (the run
 * page) the new run's own page opens, as before. `?node=` and any other query survive the switch.
 */
export function useOpenRunInPlace(): (runId: Id) => void {
  const navigate = useNavigate();
  const location = useLocation();
  return useCallback(
    (runId: Id) => {
      if (!/^\/projects\/[^/]+\/workflows\/[^/]+(\/(forge|domain))?\/?$/u.test(location.pathname)) {
        navigate(`/runs/${runId}`);
        return;
      }
      const query = new URLSearchParams(location.search);
      query.set('run', runId);
      navigate(`${location.pathname}?${query.toString()}`);
    },
    [navigate, location.pathname, location.search],
  );
}
