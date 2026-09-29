import { Link, useParams, useSearchParams } from 'react-router-dom';

import { useWorkflowSubscription } from '../app/socket';
import { TimelinePanel } from './TimelinePanel';
import { filterFromParams, paramsFromFilter, type TimelineFilter } from './timeline-messages';

/**
 * `/projects/:projectId/workflows/:workflowId/timeline` (round 4 §5 item 4): the workflow's whole
 * timeline on its own page — the same stream as the bottom tab, room to read it, and its filters in
 * the URL so a filtered view is linkable (FR-CHAT-002).
 *
 * The page is a sibling of the Canvas route, so it subscribes to the workflow scope itself; that is
 * what delivers `message.created` frames while the page is open, exactly as the Canvas does.
 */
export function TimelinePage() {
  const { projectId = '', workflowId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  useWorkflowSubscription(workflowId);

  const filter = filterFromParams(params);
  const onFilterChange = (next: TimelineFilter) => setParams(paramsFromFilter(next));

  return (
    <main className="mx-auto flex h-full w-full max-w-4xl flex-col" data-testid="timeline-page">
      <header className="flex flex-wrap items-center gap-3 px-4 py-4">
        <h1 className="font-human text-2xl font-semibold">Timeline</h1>
        <Link
          to={`/projects/${projectId}/workflows/${workflowId}`}
          className="ml-auto font-machine text-xs underline"
        >
          open the Canvas
        </Link>
      </header>
      <div className="min-h-0 flex-1 border-t border-border">
        <TimelinePanel workflowId={workflowId} filter={filter} onFilterChange={onFilterChange} />
      </div>
    </main>
  );
}
