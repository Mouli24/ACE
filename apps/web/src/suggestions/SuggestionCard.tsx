import type { Id, Suggestion, Workflow } from '@ace/contracts';
import { Badge, Button, Label, cn, toast } from '@ace/ui';
import { ArrowUpRight, Clock, Inbox, X } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';

import { selectClass } from '../knowledge/fields';
import { timeAgo } from '../tasks/meta';
import { useDecideSuggestion } from './hooks';
import { EVIDENCE_LABEL, STATUS_LABEL } from './meta';

const NO_TEAM = '';

/**
 * One suggestion (ACE parity P2, D280): why ACE thinks it is worth doing, the evidence, the proposed
 * action and when it is done. *Add to Inbox* creates an Inbox task (optionally with its team) and
 * starts nothing; *Later* keeps it out of the way; *Dismiss* is final — a later scan never suggests
 * the same thing again.
 */
export function SuggestionCard({
  suggestion,
  projectId,
  workflows,
  responsibilityTitle,
  onAccepted,
}: {
  suggestion: Suggestion;
  projectId: Id;
  workflows: readonly Workflow[];
  responsibilityTitle: string | undefined;
  /** The suggestion as the engine answered it, with the new task's id. */
  onAccepted: (accepted: Suggestion) => void;
}) {
  const decide = useDecideSuggestion(projectId);
  const [team, setTeam] = useState<Id>(NO_TEAM);
  const open = suggestion.status === 'new' || suggestion.status === 'later';
  const headingId = `suggestion-${suggestion.id}`;
  const teamId = `suggestion-team-${suggestion.id}`;

  const accept = () =>
    decide.mutate(
      {
        id: suggestion.id,
        decision: 'accept',
        ...(team === NO_TEAM ? {} : { workflowId: team }),
      },
      {
        onSuccess: (accepted) => {
          toast.success('Added to the Inbox');
          onAccepted(accepted);
        },
      },
    );

  return (
    <article
      aria-labelledby={headingId}
      data-testid={`suggestion-${suggestion.id}`}
      data-status={suggestion.status}
      className="flex flex-col gap-3 rounded-card border border-border bg-card p-4"
    >
      <header className="flex flex-col gap-1.5">
        <span className="flex flex-wrap items-center gap-1.5">
          <Badge
            data-testid="suggestion-status"
            className={cn(suggestion.status === 'new' && 'border-fg-muted text-fg')}
          >
            {STATUS_LABEL[suggestion.status]}
          </Badge>
          {responsibilityTitle !== undefined && (
            <span className="font-machine text-[10.5px] text-fg-muted">
              from “{responsibilityTitle}”
            </span>
          )}
          <time
            dateTime={suggestion.createdAt}
            title={new Date(suggestion.createdAt).toLocaleString()}
            className="font-machine text-[10.5px] text-fg-muted"
          >
            · {timeAgo(suggestion.createdAt)}
          </time>
        </span>
        <h3 id={headingId} className="font-human text-base font-semibold leading-snug">
          {suggestion.title}
        </h3>
      </header>

      <dl className="flex flex-col gap-3 font-human text-sm">
        <div>
          <dt className="text-xs text-fg-muted">Why</dt>
          <dd className="whitespace-pre-wrap">{suggestion.reason}</dd>
        </div>
        <div>
          <dt className="text-xs text-fg-muted">Evidence</dt>
          <dd>
            <ul className="mt-1 flex flex-col gap-1.5">
              {suggestion.evidence.map((item, index) => (
                <li
                  key={`${item.kind}-${index}`}
                  className="rounded-field border border-border px-3 py-2"
                >
                  <span className="flex flex-wrap items-center gap-1.5">
                    <Badge variant="outline" className="text-[10px]">
                      {EVIDENCE_LABEL[item.kind]}
                    </Badge>
                    {item.url === undefined ? (
                      <span>{item.label}</span>
                    ) : (
                      <a
                        href={item.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="inline-flex items-center gap-1 underline"
                      >
                        {item.label}
                        <ArrowUpRight className="h-3 w-3" aria-hidden />
                      </a>
                    )}
                    {item.taskId !== undefined && (
                      <Link
                        to={`/projects/${projectId}/tasks/${item.taskId}`}
                        className="font-machine text-[10.5px] text-fg-muted underline"
                      >
                        open the task
                      </Link>
                    )}
                  </span>
                  {item.detail !== undefined && item.detail !== '' && (
                    <details className="mt-1.5">
                      <summary className="cursor-pointer text-xs text-fg-muted">Details</summary>
                      <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words font-machine text-[11px] text-fg-soft">
                        {item.detail}
                      </pre>
                    </details>
                  )}
                </li>
              ))}
            </ul>
          </dd>
        </div>
        <div>
          <dt className="text-xs text-fg-muted">Proposed action</dt>
          <dd className="whitespace-pre-wrap">{suggestion.proposedAction}</dd>
        </div>
        <div>
          <dt className="text-xs text-fg-muted">Done when</dt>
          <dd className="whitespace-pre-wrap">
            {suggestion.completionCriteria === '' ? (
              <span className="text-fg-muted">
                Not said — the responsibility has no “useful work looks like”.
              </span>
            ) : (
              suggestion.completionCriteria
            )}
          </dd>
        </div>
      </dl>

      {suggestion.status === 'accepted' && suggestion.taskId !== undefined && (
        <p className="flex flex-wrap items-center gap-1.5 border-t border-border pt-3 font-human text-sm">
          <Inbox className="h-4 w-4 text-fg-muted" aria-hidden />
          Added to the Inbox as a task; it starts when you start it.
          <Link
            to={`/projects/${projectId}/tasks/${suggestion.taskId}`}
            className="font-medium underline"
          >
            Open the task
          </Link>
        </p>
      )}
      {suggestion.status === 'dismissed' && (
        <p className="border-t border-border pt-3 font-human text-sm text-fg-muted">
          Dismissed: a later scan will not suggest this again.
        </p>
      )}

      {open && (
        <div className="flex flex-col gap-2 border-t border-border pt-3 sm:flex-row sm:items-end">
          <div className="flex flex-col gap-1 sm:w-56">
            <Label htmlFor={teamId} className="text-xs text-fg-muted">
              Team for the task
            </Label>
            <select
              id={teamId}
              className={selectClass}
              value={team}
              onChange={(event) => setTeam(event.target.value)}
            >
              <option value={NO_TEAM}>No team yet</option>
              {workflows.map((workflow) => (
                <option key={workflow.id} value={workflow.id}>
                  {workflow.name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-wrap gap-1.5 sm:ml-auto">
            <Button disabled={decide.isPending} onClick={accept}>
              <Inbox className="h-4 w-4" aria-hidden /> Add to Inbox
            </Button>
            {suggestion.status === 'new' && (
              <Button
                variant="secondary"
                disabled={decide.isPending}
                onClick={() => decide.mutate({ id: suggestion.id, decision: 'later' })}
              >
                <Clock className="h-4 w-4" aria-hidden /> Later
              </Button>
            )}
            <Button
              variant="ghost"
              disabled={decide.isPending}
              onClick={() => decide.mutate({ id: suggestion.id, decision: 'dismiss' })}
            >
              <X className="h-4 w-4" aria-hidden /> Dismiss
            </Button>
          </div>
        </div>
      )}
      {decide.error && (
        <p role="alert" className="text-sm text-danger">
          {decide.error.message}
        </p>
      )}
    </article>
  );
}
