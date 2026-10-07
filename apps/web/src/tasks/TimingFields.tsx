import type { Task } from '@ace/contracts';
import { Button, Input, Label, cn } from '@ace/ui';
import { useMemo } from 'react';

import { FieldError, selectClass } from '../knowledge/fields';
import { nextOccurrence } from './cron';
import { formatWhen } from './meta';
import {
  CRON_PRESETS,
  TIMING_HINT,
  TIMING_LABEL,
  timeZones,
  toDatetimeLocal,
  type TimingDraft,
  type TimingKind,
} from './timing';

/**
 * The Timing control (ACE parity P1, D277), shared by the New task dialog and the schedule card:
 * start now, capture in the Inbox, or one of the three triggers — at a time (a local
 * `datetime-local`, sent as ISO), repeating on a cron expression in a time zone (three presets), or
 * after another task of the project. It only holds the draft; `triggerFromDraft` reads it.
 */
export function TimingFields({
  idPrefix,
  value,
  kinds,
  tasks,
  error,
  onChange,
}: {
  idPrefix: string;
  value: TimingDraft;
  kinds: readonly TimingKind[];
  /** The tasks an *after another task* trigger may wait on (the project's, not Done). */
  tasks: readonly Pick<Task, 'id' | 'number' | 'title'>[];
  error?: { field: string; message: string } | undefined;
  onChange: (next: TimingDraft) => void;
}) {
  const set = (patch: Partial<TimingDraft>) => onChange({ ...value, ...patch });
  const zones = useMemo(() => timeZones(value.timezone), [value.timezone]);
  const messageFor = (field: string) => (error?.field === field ? error.message : undefined);

  const next = useMemo(() => {
    if (value.kind !== 'recurring') return undefined;
    try {
      const at = nextOccurrence(value.cron, value.timezone, Date.now());
      return at === undefined ? undefined : new Date(at).toISOString();
    } catch {
      return undefined;
    }
  }, [value.kind, value.cron, value.timezone]);

  return (
    <fieldset className="flex flex-col gap-2" data-testid={`${idPrefix}-timing`}>
      <legend className="mb-1.5 text-sm font-medium">Timing</legend>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Timing">
        {kinds.map((kind) => (
          <label
            key={kind}
            className={cn(
              'flex cursor-pointer items-center gap-2 rounded-field border border-border px-3 py-1.5 font-human text-sm',
              value.kind === kind && 'border-fg-muted bg-card',
            )}
          >
            <input
              type="radio"
              name={`${idPrefix}-timing`}
              value={kind}
              checked={value.kind === kind}
              onChange={() => set({ kind })}
            />
            {TIMING_LABEL[kind]}
          </label>
        ))}
      </div>
      <p className="text-xs text-fg-muted">{TIMING_HINT[value.kind]}</p>

      {value.kind === 'once' && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${idPrefix}-at`}>Starts at</Label>
          <Input
            id={`${idPrefix}-at`}
            type="datetime-local"
            value={value.at}
            min={toDatetimeLocal(new Date().toISOString())}
            aria-invalid={messageFor('at') ? true : undefined}
            aria-describedby={messageFor('at') ? `${idPrefix}-at-error` : undefined}
            className="w-full sm:w-64"
            onChange={(event) => set({ at: event.target.value })}
          />
          <FieldError id={`${idPrefix}-at-error`} message={messageFor('at')} />
        </div>
      )}

      {value.kind === 'recurring' && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${idPrefix}-cron`}>Cron expression</Label>
            <Input
              id={`${idPrefix}-cron`}
              value={value.cron}
              placeholder="0 9 * * 1-5"
              className="font-machine"
              aria-invalid={messageFor('cron') ? true : undefined}
              aria-describedby={`${idPrefix}-cron-hint`}
              onChange={(event) => set({ cron: event.target.value })}
            />
            <div className="flex flex-wrap gap-1.5" aria-label="Presets">
              {CRON_PRESETS.map((preset) => (
                <Button
                  key={preset.cron}
                  type="button"
                  size="sm"
                  variant={value.cron.trim() === preset.cron ? 'secondary' : 'ghost'}
                  aria-pressed={value.cron.trim() === preset.cron}
                  onClick={() => set({ cron: preset.cron })}
                >
                  {preset.label}
                </Button>
              ))}
            </div>
            <p id={`${idPrefix}-cron-hint`} className="text-xs text-fg-muted">
              minute hour day month weekday
              {next !== undefined && (
                <>
                  {' '}
                  · next: <span data-testid={`${idPrefix}-next`}>{formatWhen(next)}</span>
                </>
              )}
            </p>
            <FieldError id={`${idPrefix}-cron-error`} message={messageFor('cron')} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${idPrefix}-timezone`}>Time zone</Label>
            <select
              id={`${idPrefix}-timezone`}
              className={selectClass}
              value={value.timezone}
              aria-invalid={messageFor('timezone') ? true : undefined}
              onChange={(event) => set({ timezone: event.target.value })}
            >
              {zones.map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </select>
            <FieldError id={`${idPrefix}-timezone-error`} message={messageFor('timezone')} />
          </div>
        </div>
      )}

      {value.kind === 'after_task' && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${idPrefix}-after`}>Wait for</Label>
          <select
            id={`${idPrefix}-after`}
            className={selectClass}
            value={value.afterTaskId}
            aria-invalid={messageFor('afterTaskId') ? true : undefined}
            onChange={(event) => set({ afterTaskId: event.target.value })}
          >
            <option value="">Choose a task…</option>
            {tasks.map((task) => (
              <option key={task.id} value={task.id}>
                #{task.number} {task.title}
              </option>
            ))}
          </select>
          {tasks.length === 0 && (
            <p className="text-xs text-fg-muted">
              This project has no other task that is not Done.
            </p>
          )}
          <FieldError id={`${idPrefix}-after-error`} message={messageFor('afterTaskId')} />
        </div>
      )}
    </fieldset>
  );
}
