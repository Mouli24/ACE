import type { Responsibility } from '@ace/contracts';
import { Badge, Button, Checkbox, Label, cn, toast } from '@ace/ui';
import { Loader2, Pause, Pencil, Play, Radar, Trash2, X } from 'lucide-react';

import { selectClass } from '../knowledge/fields';
import { timeAgo } from '../tasks/meta';
import { isScanning, useCancelScan, useScanResponsibility, useUpdateResponsibility } from './hooks';
import { KIND_LABEL, SCAN_STATUS_LABEL, WATCH_INTERVALS, intervalLabel } from './meta';

/**
 * One responsibility (ACE parity P2, D280): what it watches and why, its last scan, *Scan now* /
 * *Cancel* while one runs, *Watch automatically* with its interval, pause, edit and delete. Every
 * control is one engine call; the card shows what the engine answered.
 */
export function ResponsibilityCard({
  responsibility,
  onEdit,
  onDelete,
}: {
  responsibility: Responsibility;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const scan = useScanResponsibility();
  const cancel = useCancelScan();
  const update = useUpdateResponsibility();
  const running = isScanning(responsibility);
  const id = responsibility.id;
  const headingId = `responsibility-${id}`;
  const intervals = [
    ...new Set<number>([...WATCH_INTERVALS, responsibility.watchIntervalMinutes]),
  ].sort((a, b) => a - b);

  const patch = (body: Parameters<typeof update.mutate>[0]['body'], what: string) =>
    update.mutate(
      { id, body },
      {
        onError: (error) => toast.error(`${what} not saved`, { description: error.message }),
      },
    );

  const scanError = scan.error ?? cancel.error;

  return (
    <article
      aria-labelledby={headingId}
      data-testid={`responsibility-${id}`}
      className="flex flex-col gap-3 rounded-card border border-border bg-panel p-4"
    >
      <header className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h3 id={headingId} className="font-human text-base font-semibold leading-snug">
            {responsibility.title}
          </h3>
          <span className="mt-1 flex flex-wrap items-center gap-1.5">
            <Badge>{KIND_LABEL[responsibility.kind]}</Badge>
            {responsibility.paused && <Badge data-testid="responsibility-paused">paused</Badge>}
            {responsibility.watch && !responsibility.paused && (
              <Badge data-testid="responsibility-watching">
                watching · every {intervalLabel(responsibility.watchIntervalMinutes)}
              </Badge>
            )}
          </span>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1">
          {running ? (
            <Button
              variant="secondary"
              size="sm"
              disabled={cancel.isPending}
              onClick={() => cancel.mutate(id)}
            >
              <X className="h-4 w-4" aria-hidden /> Cancel scan
            </Button>
          ) : (
            <Button size="sm" disabled={scan.isPending} onClick={() => scan.mutate(id)}>
              <Radar className="h-4 w-4" aria-hidden /> Scan now
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Edit ${responsibility.title}`}
            onClick={onEdit}
          >
            <Pencil className="h-4 w-4" aria-hidden />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Delete ${responsibility.title}`}
            onClick={onDelete}
          >
            <Trash2 className="h-4 w-4 text-danger" aria-hidden />
          </Button>
        </div>
      </header>

      {(responsibility.why !== '' ||
        responsibility.goodWork !== '' ||
        responsibility.query !== undefined) && (
        <dl className="grid grid-cols-1 gap-2 font-human text-sm sm:grid-cols-2">
          {responsibility.why !== '' && (
            <div>
              <dt className="text-xs text-fg-muted">Why it matters</dt>
              <dd className="whitespace-pre-wrap">{responsibility.why}</dd>
            </div>
          )}
          {responsibility.goodWork !== '' && (
            <div>
              <dt className="text-xs text-fg-muted">Useful work looks like</dt>
              <dd className="whitespace-pre-wrap">{responsibility.goodWork}</dd>
            </div>
          )}
          {responsibility.query !== undefined && responsibility.query !== '' && (
            <div>
              <dt className="text-xs text-fg-muted">Messages to match</dt>
              <dd className="font-machine text-xs">{responsibility.query}</dd>
            </div>
          )}
        </dl>
      )}

      <LastScan responsibility={responsibility} />
      {responsibility.kind === 'email' && (
        <p className="font-human text-xs text-fg-muted">
          Scanning email needs a mail connection, which this version of ACE does not have; the
          engine answers that it is not connected.
        </p>
      )}
      {scanError && (
        <p role="alert" className="text-sm text-danger">
          {scanError.message}
        </p>
      )}

      <div className="flex flex-col gap-3 border-t border-border pt-3 sm:flex-row sm:flex-wrap sm:items-center">
        <div className="flex items-center gap-2">
          <Checkbox
            id={`watch-${id}`}
            checked={responsibility.watch}
            disabled={update.isPending}
            onCheckedChange={(checked) => patch({ watch: checked === true }, 'Watch automatically')}
          />
          <Label htmlFor={`watch-${id}`}>Watch automatically</Label>
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor={`interval-${id}`} className="text-fg-muted">
            every
          </Label>
          <select
            id={`interval-${id}`}
            className={cn(selectClass, 'w-36')}
            value={responsibility.watchIntervalMinutes}
            disabled={update.isPending}
            onChange={(event) =>
              patch({ watchIntervalMinutes: Number(event.target.value) }, 'Watch interval')
            }
          >
            {intervals.map((minutes) => (
              <option key={minutes} value={minutes}>
                {intervalLabel(minutes)}
              </option>
            ))}
          </select>
        </div>
        <Button
          variant="secondary"
          size="sm"
          className="sm:ml-auto"
          disabled={update.isPending}
          onClick={() =>
            patch({ paused: !responsibility.paused }, responsibility.paused ? 'Resume' : 'Pause')
          }
        >
          {responsibility.paused ? (
            <>
              <Play className="h-4 w-4" aria-hidden /> Resume watching
            </>
          ) : (
            <>
              <Pause className="h-4 w-4" aria-hidden /> Pause watching
            </>
          )}
        </Button>
      </div>
    </article>
  );
}

function LastScan({ responsibility }: { responsibility: Responsibility }) {
  const status = responsibility.lastScanStatus;
  if (status === undefined) {
    return (
      <p data-testid="last-scan" className="font-human text-sm text-fg-muted">
        Not scanned yet.
      </p>
    );
  }
  const at = responsibility.lastScanAt;
  return (
    <p
      data-testid="last-scan"
      data-status={status}
      role="status"
      className={cn('font-human text-sm', status === 'failed' ? 'text-danger' : 'text-fg-soft')}
    >
      {status === 'running' && (
        <Loader2 className="mr-1.5 inline h-3.5 w-3.5 animate-spin align-[-2px]" aria-hidden />
      )}
      <span className="font-medium">{SCAN_STATUS_LABEL[status]}</span>
      {responsibility.lastScanMessage !== undefined && <> — {responsibility.lastScanMessage}</>}
      {status !== 'running' && at !== undefined && (
        <>
          {' · '}
          <time dateTime={at} title={new Date(at).toLocaleString()} className="text-fg-muted">
            {timeAgo(at)}
          </time>
        </>
      )}
    </p>
  );
}
