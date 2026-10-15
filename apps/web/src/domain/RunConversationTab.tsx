import { rosterFor, type Id } from '@ace/contracts';
import { useLayoutEffect, useMemo, useRef } from 'react';
import { Link } from 'react-router-dom';

import { workflowPath } from '../forge/mode';
import { useNodeRuns, useRun } from '../runs/hooks';
import { useSelectedRun } from '../runs/selected-run';
import { Conversation, DomainEmpty } from './Conversation';
import { orderedMessages } from './conversation-state';
import { isLiveRun, useDomainConversation } from './hooks';
import { domainLooks } from './looks';

/**
 * PG-3.6: the chat column's "Run" tab — the selected run's team conversation, as Domain shows it,
 * read-only, with a link to Domain to take part. The run is the workflow's one selected run
 * (PG-3.2), as in every mode.
 */
export function RunConversationTab({
  projectId,
  workflowId,
}: {
  projectId: string;
  workflowId: string;
}) {
  const runId: Id | undefined = useSelectedRun(workflowId).runId;
  const run = useRun(runId);
  const nodeRuns = useNodeRuns(runId);
  const live = run.data !== undefined && isLiveRun(run.data);
  const conversation = useDomainConversation(run.data?.id, { live });
  const { byId } = conversation;
  const messages = useMemo(() => orderedMessages({ byId }), [byId]);
  const roster = useMemo(
    () => (run.data === undefined ? [] : rosterFor(run.data.snapshot.nodes)),
    [run.data],
  );
  const names = useMemo(
    () => new Map((run.data?.snapshot.nodes ?? []).map((each) => [each.id, each.name])),
    [run.data],
  );
  const looks = useMemo(() => domainLooks(run.data?.snapshot.nodes ?? []), [run.data]);

  const scroller = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element !== null) element.scrollTop = element.scrollHeight;
  }, [messages, conversation.tokens]);

  const domainHref =
    runId === undefined
      ? workflowPath(projectId, workflowId, 'domain')
      : `${workflowPath(projectId, workflowId, 'domain')}?run=${encodeURIComponent(runId)}`;

  return (
    <div data-testid="chat-run-tab" className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-[var(--line)] px-[14px] py-[8px] text-[11px]">
        <span className="min-w-0 flex-1 truncate text-[var(--muted)]">
          {run.data === undefined
            ? 'No run yet'
            : `Run · ${run.data.status}${live ? ' · live' : ''}`}
        </span>
        <Link
          to={domainHref}
          data-testid="chat-run-open-domain"
          className="shrink-0 font-semibold text-[#e8623a] hover:text-[#c94c27]"
        >
          Open in Domain →
        </Link>
      </div>
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
        {conversation.error !== undefined && (
          <p role="alert" className="px-[14px] pt-3 text-center text-[12px] text-[#c94c27]">
            {conversation.error}
          </p>
        )}
        {runId === undefined ? (
          <DomainEmpty>This workflow has no runs yet.</DomainEmpty>
        ) : (
          <Conversation
            messages={messages}
            roster={roster}
            names={names}
            looks={looks}
            tokens={conversation.tokens}
            // A projection to read here; routing and retries are Domain's.
            readOnly
            onRoute={() => Promise.resolve()}
            {...(nodeRuns.data === undefined ? {} : { nodeRuns: nodeRuns.data })}
          />
        )}
      </div>
    </div>
  );
}
