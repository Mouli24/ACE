import { Link } from 'react-router-dom';
import { useState } from 'react';
import { Maximize2 } from 'lucide-react';

import { TimelinePanel } from '../timeline/TimelinePanel';
import type { TimelineFilter } from '../timeline/timeline-messages';

/**
 * The bottom pane's "Timeline" tab (round 4 §5 item 4, FR-CHAT-001/002/003). It is the workflow's
 * message stream — what the user sent, what each agent answered, an Output node's final result, the
 * run's own events and errors, and the engine's notices — with filters and a "Send to workflow"
 * composer.
 *
 * The tab keeps its filter in local state; the full page keeps the same filter in the URL so a
 * filtered timeline is linkable (FR-CHAT-002). A corner link opens that page.
 */
export function TimelineTab({ workflowId, projectId }: { workflowId: string; projectId?: string }) {
  const [filter, setFilter] = useState<TimelineFilter>({});

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="timeline-tab">
      {projectId !== undefined && (
        <div className="flex items-center justify-end px-3 pt-2">
          <Link
            to={`/projects/${projectId}/workflows/${workflowId}/timeline`}
            className="inline-flex items-center gap-1 font-machine text-xs text-accent underline-offset-2 hover:underline"
            data-testid="timeline-open-full"
          >
            <Maximize2 className="h-3.5 w-3.5" aria-hidden />
            open full timeline
          </Link>
        </div>
      )}
      <TimelinePanel workflowId={workflowId} filter={filter} onFilterChange={setFilter} />
    </div>
  );
}
