import {
  CreateResponsibilityRequestSchema,
  DEFAULT_WATCH_INTERVAL_MINUTES,
  RESPONSIBILITY_KINDS,
  UpdateResponsibilityRequestSchema,
  type Id,
  type Responsibility,
  type ResponsibilityKind,
} from '@ace/contracts';
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Textarea,
  cn,
  toast,
} from '@ace/ui';
import { useState, type FormEvent } from 'react';

import { FieldError, fieldErrors, selectClass, type FieldErrors } from '../knowledge/fields';
import { useCreateResponsibility, useUpdateResponsibility } from './hooks';
import { KIND_HINT, KIND_LABEL, WATCH_INTERVALS, intervalLabel } from './meta';

/**
 * New / Edit responsibility (ACE parity P2, D280): what ACE should watch, why it matters and what
 * useful work would look like — the last becomes each suggestion's completion criteria. Saving one
 * scans nothing; *Watch automatically* scans on a timer while the engine runs.
 */
export function ResponsibilityDialog({
  projectId,
  responsibility,
  onClose,
}: {
  projectId: Id;
  /** Absent: a new one. */
  responsibility?: Responsibility;
  onClose: () => void;
}) {
  const editing = responsibility !== undefined;
  const create = useCreateResponsibility(projectId);
  const update = useUpdateResponsibility();
  const mutation = editing ? update : create;

  const [kind, setKind] = useState<ResponsibilityKind>(responsibility?.kind ?? 'software_health');
  const [title, setTitle] = useState(responsibility?.title ?? '');
  const [why, setWhy] = useState(responsibility?.why ?? '');
  const [goodWork, setGoodWork] = useState(responsibility?.goodWork ?? '');
  const [query, setQuery] = useState(responsibility?.query ?? '');
  const [watch, setWatch] = useState(responsibility?.watch ?? false);
  const [intervalMinutes, setIntervalMinutes] = useState(
    responsibility?.watchIntervalMinutes ?? DEFAULT_WATCH_INTERVAL_MINUTES,
  );
  const [errors, setErrors] = useState<FieldErrors>({});

  const intervals = [...new Set<number>([...WATCH_INTERVALS, intervalMinutes])].sort(
    (a, b) => a - b,
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const fields = {
      title: title.trim(),
      why: why.trim(),
      goodWork: goodWork.trim(),
      ...(kind === 'email' ? { query: query.trim() } : {}),
      watch,
      watchIntervalMinutes: intervalMinutes,
    };
    const done = (saved: Responsibility) => {
      toast.success(editing ? `"${saved.title}" saved` : `"${saved.title}" added`);
      onClose();
    };
    if (editing) {
      const parsed = UpdateResponsibilityRequestSchema.safeParse(fields);
      if (!parsed.success) {
        setErrors(fieldErrors(parsed.error));
        return;
      }
      setErrors({});
      update.mutate({ id: responsibility.id, body: parsed.data }, { onSuccess: done });
      return;
    }
    const parsed = CreateResponsibilityRequestSchema.safeParse({ kind, ...fields });
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    setErrors({});
    create.mutate(parsed.data, { onSuccess: done });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-[calc(100vw-2rem)] overflow-y-auto sm:max-w-xl">
        <form onSubmit={submit} noValidate className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit responsibility' : 'New responsibility'}</DialogTitle>
            <DialogDescription>
              Say what ACE should watch, why it matters and what useful work would look like. Saving
              it scans nothing: press Scan now, or turn on Watch automatically.
            </DialogDescription>
          </DialogHeader>

          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1.5 text-sm font-medium">What it looks at</legend>
            <div className="flex flex-wrap gap-2">
              {RESPONSIBILITY_KINDS.map((option) => (
                <label
                  key={option}
                  className={cn(
                    'flex items-center gap-2 rounded-field border border-border px-3 py-1.5 font-human text-sm',
                    kind === option && 'border-fg-muted bg-card',
                    editing && kind !== option && 'opacity-50',
                  )}
                >
                  <input
                    type="radio"
                    name="responsibility-kind"
                    value={option}
                    checked={kind === option}
                    disabled={editing}
                    onChange={() => setKind(option)}
                  />
                  {KIND_LABEL[option]}
                </label>
              ))}
            </div>
            <p className="text-xs text-fg-muted">
              {KIND_HINT[kind]}
              {editing ? ' The kind cannot change once saved.' : ''}
            </p>
          </fieldset>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="responsibility-title">What to watch</Label>
            <Input
              id="responsibility-title"
              value={title}
              maxLength={200}
              autoFocus
              placeholder="e.g. Keep the checks green"
              aria-invalid={errors['title'] ? true : undefined}
              aria-describedby={errors['title'] ? 'responsibility-title-error' : undefined}
              onChange={(event) => setTitle(event.target.value)}
            />
            <FieldError
              id="responsibility-title-error"
              message={errors['title'] && 'Say what ACE should watch.'}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="responsibility-why">Why it matters</Label>
            <Textarea
              id="responsibility-why"
              rows={2}
              value={why}
              maxLength={4_000}
              onChange={(event) => setWhy(event.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="responsibility-good-work">What useful work looks like</Label>
            <Textarea
              id="responsibility-good-work"
              rows={2}
              value={goodWork}
              maxLength={4_000}
              placeholder="e.g. Every check passes on main."
              aria-describedby="responsibility-good-work-hint"
              onChange={(event) => setGoodWork(event.target.value)}
            />
            <p id="responsibility-good-work-hint" className="text-xs text-fg-muted">
              Each suggestion it finds gets this as its completion criteria.
            </p>
          </div>

          {kind === 'email' && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="responsibility-query">Messages to match</Label>
              <Input
                id="responsibility-query"
                value={query}
                maxLength={400}
                placeholder="e.g. to:support@example.com is:unread"
                onChange={(event) => setQuery(event.target.value)}
              />
              <FieldError id="responsibility-query-error" message={errors['query']} />
            </div>
          )}

          <div className="flex flex-col gap-2 rounded-field border border-border p-3">
            <div className="flex items-center gap-2">
              <Checkbox
                id="responsibility-watch"
                checked={watch}
                onCheckedChange={(checked) => setWatch(checked === true)}
              />
              <Label htmlFor="responsibility-watch">Watch automatically</Label>
            </div>
            <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
              <Label htmlFor="responsibility-interval" className="text-fg-muted">
                Scan every
              </Label>
              <select
                id="responsibility-interval"
                className={cn(selectClass, 'sm:w-48')}
                value={intervalMinutes}
                onChange={(event) => setIntervalMinutes(Number(event.target.value))}
              >
                {intervals.map((minutes) => (
                  <option key={minutes} value={minutes}>
                    {intervalLabel(minutes)}
                  </option>
                ))}
              </select>
            </div>
            <p className="text-xs text-fg-muted">
              While the engine runs, and never while this responsibility or its project is paused.
            </p>
          </div>

          {mutation.error && (
            <p role="alert" className="text-sm text-danger">
              {mutation.error.message}
            </p>
          )}

          <DialogFooter className="gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {editing ? 'Save' : 'Add responsibility'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
