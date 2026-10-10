import { rosterFor, type Id, type NodeState, type RosterEntry } from '@ace/contracts';
import { Button } from '@ace/ui';
import { useMemo } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';

import { SHORTCUTS, useShortcuts } from '../app/shortcuts';
import { workflowPath } from '../forge/mode';
import { useEndRun, useRun, useRuns, useStartRun } from '../runs/hooks';
import { Composer } from './Composer';
import { orderedMessages } from './conversation-state';
import { Conversation } from './Conversation';
import {
  isLiveRun,
  useDomainConversation,
  usePostRunMessage,
  useRouteEnvelope,
  useSetRunBudget,
} from './hooks';
import { TeamPanel } from './TeamPanel';

/**
 * Domain (D303–D327): a run as its team's conversation — who did what, what went to whom, who is
 * stuck, and what it cost. `?run=` picks the run (the live one by default), `?node=` a node's lens.
 * A run that has ended opens read-only. Functional and unstyled: the visual pass comes later.
 */
export function DomainPage() {
  const { projectId = '', workflowId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  // The mode switch's keys work here too (D299): Domain sits outside the workflow layout.
  useShortcuts([
    [SHORTCUTS.ideate, () => navigate(workflowPath(projectId, workflowId, 'ideate'))],
    [SHORTCUTS.forge, () => navigate(workflowPath(projectId, workflowId, 'forge'))],
  ]);
  const runs = useRuns(workflowId);
  const requested = params.get('run') ?? undefined;
  const node = params.get('node') ?? undefined;

  const fallback = useMemo(() => {
    const list = runs.data ?? [];
    return (list.find((summary) => isLiveRun(summary)) ?? list[0])?.id;
  }, [runs.data]);
  // `?run=new`: write a goal to start a new run, whatever ran before.
  const runId = requested === 'new' ? undefined : (requested ?? fallback);
  const run = useRun(runId);
  const live = run.data !== undefined && isLiveRun(run.data);
  const roster: RosterEntry[] = useMemo(
    () => (run.data === undefined ? [] : rosterFor(run.data.snapshot.nodes)),
    [run.data],
  );
  /** Every node's name, so a node with no handle (an Input, an Output) is named, not an id. */
  const names = useMemo(
    () => new Map((run.data?.snapshot.nodes ?? []).map((each) => [each.id, each.name])),
    [run.data],
  );

  // Read once the run is known, so the page knows whether it is live before it shows anything.
  const conversation = useDomainConversation(run.data?.id, {
    ...(node === undefined ? {} : { node }),
    live,
  });
  const states: Record<Id, NodeState> = useMemo(
    () =>
      Object.fromEntries(
        (conversation.usage?.perNode ?? []).map((entry) => [entry.nodeId, entry.state]),
      ),
    [conversation.usage],
  );

  const post = usePostRunMessage(runId);
  const route = useRouteEnvelope(runId);
  const budget = useSetRunBudget(runId);
  const end = useEndRun();
  const start = useStartRun(workflowId);

  const select = (next: { run?: Id; node?: Id }): void => {
    const query = new URLSearchParams();
    const nextRun = 'run' in next ? next.run : runId;
    if (nextRun !== undefined) query.set('run', nextRun);
    const nextNode = 'node' in next ? next.node : node;
    if (nextNode !== undefined) query.set('node', nextNode);
    setParams(query);
  };

  const canEnd = live && (run.data?.allowedActions ?? []).includes('end');
  const knownRuns = runs.data ?? [];
  const missing =
    runId !== undefined && run.data !== undefined && !knownRuns.some((each) => each.id === runId);

  return (
    <div data-testid="domain-page" className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_320px]">
      <main aria-label="Domain" className="flex min-h-0 flex-col">
        <header className="flex flex-wrap items-center gap-2 border-b border-border p-3 text-sm">
          <h1 className="font-semibold">Domain</h1>
          <Link to={`/projects/${projectId}/workflows/${workflowId}`} className="text-xs underline">
            Board
          </Link>
          <label className="flex items-center gap-1 text-xs">
            Run
            <select
              aria-label="Run"
              className="rounded border border-border bg-transparent px-1"
              value={runId ?? ''}
              onChange={(event) => select({ run: event.target.value, node: undefined })}
            >
              {runId === undefined && <option value="new">New run</option>}
              {missing && run.data !== undefined && (
                <option value={run.data.id}>
                  {run.data.status} · {new Date(run.data.startedAt).toLocaleString()}
                </option>
              )}
              {knownRuns.map((summary) => (
                <option key={summary.id} value={summary.id}>
                  {summary.status} · {new Date(summary.startedAt).toLocaleString()}
                </option>
              ))}
            </select>
          </label>
          {run.data !== undefined && (
            <span data-testid="domain-run-status" className="text-xs">
              {run.data.status}
              {run.data.blockedReason !== undefined && ` · ${run.data.blockedReason}`}
            </span>
          )}
          <div className="flex-1" />
          {runId !== undefined && (
            <Link to={`/runs/${runId}`} className="text-xs underline">
              Run details
            </Link>
          )}
          {!live && runId !== undefined && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => select({ run: 'new', node: undefined })}
            >
              New run
            </Button>
          )}
          {canEnd && runId !== undefined && (
            <Button
              size="sm"
              variant="destructive"
              disabled={end.isPending}
              onClick={() => end.mutate(runId)}
            >
              End run
            </Button>
          )}
        </header>

        {roster.length > 0 && (
          <nav
            aria-label="Lenses"
            className="flex flex-wrap gap-1 border-b border-border px-3 py-2 text-xs"
          >
            <button
              type="button"
              aria-pressed={node === undefined}
              className="rounded border border-border px-2 aria-pressed:bg-border"
              onClick={() => select({ node: undefined })}
            >
              All
            </button>
            {roster.map((entry) => (
              <button
                key={entry.nodeId}
                type="button"
                aria-pressed={node === entry.nodeId}
                title={entry.name}
                className="rounded border border-border px-2 aria-pressed:bg-border"
                onClick={() => select({ node: entry.nodeId })}
              >
                @{entry.handle}
              </button>
            ))}
          </nav>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {conversation.error !== undefined && (
            <p role="alert" className="p-3 text-sm text-danger">
              {conversation.error}
            </p>
          )}
          {runId === undefined ? (
            <p className="p-3 text-sm text-fg-muted">This workflow has no runs yet.</p>
          ) : (
            <Conversation
              messages={orderedMessages(conversation)}
              roster={roster}
              names={names}
              tokens={conversation.tokens}
              readOnly={!live}
              onRoute={(envelopeId, body) => route.mutateAsync({ envelopeId, body })}
            />
          )}
        </div>

        {(runId === undefined || run.data !== undefined) && (
          <Composer
            roster={roster}
            states={states}
            live={live}
            // An ended run's conversation is read-only, but the composer never is: a message
            // starts a new run, with itself as the goal (D3, D312).
            ended={runId !== undefined && !live}
            onSend={(body) => post.mutateAsync(body)}
            onStart={async (goal) => {
              // D312: the message is the run's goal; a run started here stays open (D323).
              const created = await start.mutateAsync({ goal, domain: { stayOpen: true } });
              select({ run: created.id, node: undefined });
            }}
          />
        )}
      </main>
      <TeamPanel
        usage={conversation.usage}
        readOnly={!live}
        onSetBudget={(limit) => budget.mutateAsync(limit)}
      />
    </div>
  );
}
