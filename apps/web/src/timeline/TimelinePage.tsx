import { Link, useParams, useSearchParams } from 'react-router-dom';

import { useWorkflowSubscription } from '../app/socket';
import { workflowPath } from '../forge/mode';
import { TimelinePanel } from './TimelinePanel';
import { filterFromParams, paramsFromFilter, type TimelineFilter } from './timeline-messages';

/** The output card's action button, as a link (D328). */
const ACTION_LINK =
  'inline-flex h-[28px] items-center whitespace-nowrap rounded-[8px] border border-[var(--line)] bg-[var(--chip)] px-3 text-[12px] font-semibold text-[var(--ink)] outline-none hover:bg-[var(--hover)] hover:text-[var(--ink)] focus-visible:shadow-[0_0_0_2px_var(--focus)]';

/**
 * `/projects/:projectId/workflows/:workflowId/timeline` (round 4 §5 item 4): the workflow's whole
 * timeline on its own page — the same stream as the bottom tab, room to read it, and its filters in
 * the URL so a filtered view is linkable (FR-CHAT-002).
 *
 * The page is a sibling of the Canvas route, so it subscribes to the workflow scope itself; that is
 * what delivers `message.created` frames while the page is open, exactly as the Canvas does.
 *
 * An uncovered screen in the theme (D328): a 960px column, a 20px title, the output card's action
 * button as the way back, and the timeline in a surface card.
 */
export function TimelinePage() {
  const { projectId = '', workflowId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  useWorkflowSubscription(workflowId);

  const filter = filterFromParams(params);
  const onFilterChange = (next: TimelineFilter) => setParams(paramsFromFilter(next));

  return (
    <main
      className="mx-auto flex h-full w-full max-w-[960px] flex-col gap-4 px-6 py-8 text-[var(--ink)]"
      data-testid="timeline-page"
    >
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="m-0 text-[20px] font-bold tracking-[-0.01em]">Timeline</h1>
        <Link
          to={`/projects/${projectId}/workflows/${workflowId}`}
          className={`ml-auto ${ACTION_LINK}`}
        >
          open the Canvas<span aria-hidden>&nbsp;→</span>
        </Link>
        {/* PG-3.7: the workflow's other two modes from here as well. */}
        <Link
          to={workflowPath(projectId, workflowId, 'forge')}
          className={ACTION_LINK}
          data-testid="timeline-open-forge"
        >
          Forge<span aria-hidden>&nbsp;→</span>
        </Link>
        <Link
          to={workflowPath(projectId, workflowId, 'domain')}
          className={ACTION_LINK}
          data-testid="timeline-open-domain"
        >
          Domain<span aria-hidden>&nbsp;→</span>
        </Link>
      </header>
      <div className="min-h-0 flex-1 overflow-hidden rounded-[12px] border border-[var(--line)] bg-[var(--surface)]">
        <TimelinePanel workflowId={workflowId} filter={filter} onFilterChange={onFilterChange} />
      </div>
    </main>
  );
}
