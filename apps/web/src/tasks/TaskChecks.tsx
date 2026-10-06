import type { TaskCheck, TaskWorkspace } from '@ace/contracts';
import { Badge, CodeBlock } from '@ace/ui';
import { useState } from 'react';
import { Link } from 'react-router-dom';

import { splitChecks } from './checks';
import { CHECK_STATUS_COLOR, shortSha, timeAgo } from './meta';

/**
 * The Checks tab (ACE parity P0, design §5, §8): the latest result per check for the workspace's
 * head — what Apply reads — each with its command and an expandable output; results of earlier
 * commits or runs are folded away below.
 */
export function TaskChecks({
  checks,
  workspace,
  projectId,
}: {
  checks: readonly TaskCheck[];
  workspace?: TaskWorkspace;
  projectId: string;
}) {
  const { headSha, latest, older } = splitChecks(checks, workspace?.headSha);

  if (checks.length === 0) {
    return (
      <p data-testid="checks-empty" className="font-human text-sm text-fg-muted">
        No checks have run yet. The project’s check commands run after each work run —{' '}
        <Link to={`/projects/${projectId}/settings`} className="underline">
          set them in the project settings
        </Link>
        .
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4" data-testid="task-checks">
      {headSha !== undefined && (
        <p className="font-machine text-[11px] text-fg-muted">On {shortSha(headSha)}</p>
      )}
      {latest.length === 0 ? (
        <p className="font-human text-sm text-fg-muted">
          No check has run on the latest changes yet.
        </p>
      ) : (
        <ul aria-label="Latest checks" className="flex flex-col gap-2">
          {latest.map((check) => (
            <li key={check.id}>
              <CheckRow check={check} />
            </li>
          ))}
        </ul>
      )}
      {older.length > 0 && (
        <details className="rounded-field border border-border px-3 py-2">
          <summary className="cursor-pointer font-human text-sm text-fg-soft">
            Older results ({older.length})
          </summary>
          <ul aria-label="Older checks" className="mt-2 flex flex-col gap-2">
            {older.map((check) => (
              <li key={check.id}>
                <CheckRow check={check} showHead />
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function CheckRow({ check, showHead = false }: { check: TaskCheck; showHead?: boolean }) {
  const [open, setOpen] = useState(false);
  const color = CHECK_STATUS_COLOR[check.status];
  return (
    <div
      data-testid={`check-${check.name}`}
      className="flex flex-col gap-2 rounded-field border border-border bg-panel px-3 py-2"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-human text-sm font-semibold">{check.name}</span>
        <Badge
          data-testid="check-status"
          style={{ color, borderColor: `color-mix(in oklab, ${color} 45%, var(--color-border))` }}
        >
          {check.status}
        </Badge>
        <code className="min-w-0 truncate font-machine text-[11px] text-fg-muted">
          {check.command}
        </code>
        <div className="flex-1" />
        <span className="font-machine text-[10.5px] text-fg-muted">
          {(check.durationMs / 1000).toFixed(1)} s
          {check.exitCode !== undefined ? ` · exit ${check.exitCode}` : ''}
          {showHead ? ` · ${shortSha(check.headSha)}` : ''} · {timeAgo(check.at)}
        </span>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="font-machine text-[11px] text-fg-soft underline-offset-2 hover:underline"
        >
          {open ? 'Hide output' : 'Show output'}
        </button>
      </div>
      {open && <CodeBlock language="text" text={check.output || '(no output)'} />}
    </div>
  );
}
