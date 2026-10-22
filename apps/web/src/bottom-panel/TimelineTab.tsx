import { Link } from 'react-router-dom';
import { useState } from 'react';

import { TimelinePanel } from '../timeline/TimelinePanel';
import type { TimelineFilter } from '../timeline/timeline-messages';

/**
 * The bottom pane's "Timeline" tab (round 4 §5 item 4, FR-CHAT-001/002/003). It is the workflow's
 * message stream — what the user sent, what each agent answered, an Output node's final result, the
 * run's own events and errors, and the engine's notices — with filters and a "Send to workflow"
 * composer.
 *
 * The tab keeps its filter in local state; the full page keeps the same filter in the URL so a
 * filtered timeline is linkable (FR-CHAT-002). A corner link — the theme's ⛶ and link colour —
 * opens that page.
 */
export function TimelineTab({ workflowId, projectId }: { workflowId: string; projectId?: string }) {
  const [filter, setFilter] = useState<TimelineFilter>({});

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="timeline-tab">
      {projectId !== undefined && (
        <div className="flex items-center justify-end px-3 pt-2">
          <Link
            to={`/projects/${projectId}/workflows/${workflowId}/timeline`}
            className="inline-flex items-center gap-[5px] rounded-[4px] text-[11.5px] font-semibold text-[#e8623a] outline-none hover:text-danger focus-visible:shadow-[0_0_0_2px_var(--focus)]"
            data-testid="timeline-open-full"
          >
            <span aria-hidden>⛶</span>
            open full timeline
          </Link>
        </div>
      )}
      <TimelinePanel workflowId={workflowId} filter={filter} onFilterChange={setFilter} />
    </div>
  );
}
