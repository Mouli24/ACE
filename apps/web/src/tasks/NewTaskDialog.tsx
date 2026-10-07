import {
  CreateTaskRequestSchema,
  DEFAULT_FINISH_LINE,
  DEFAULT_TASK_AUTOMATION,
  EmailAddressSchema,
  FINISH_LINES_BY_TYPE,
  ProjectRelativePathSchema,
  TASK_AUTOMATIONS,
  TASK_BRIEF_MAX,
  TASK_PRIORITIES,
  TASK_TITLE_MAX,
  TASK_TYPES,
  type CreateTaskRequest,
  type FinishLine,
  type Id,
  type Task,
  type TaskAutomation,
  type TaskPriority,
  type TaskSource,
  type TaskType,
  type Workflow,
} from '@ace/contracts';
import {
  Button,
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
import { useMemo, useState, type FormEvent } from 'react';

import { FieldError, fieldErrors, selectClass, type FieldErrors } from '../knowledge/fields';
import { useCreateTask, useTasks } from './hooks';
import {
  AUTOMATION_META,
  FINISH_LINES_UNAVAILABLE,
  PRIORITY_LABEL,
  TYPE_LABEL,
  finishLineOption,
  parseAddresses,
  parseLabels,
} from './meta';
import { TimingFields } from './TimingFields';
import { emptyTiming, triggerFromDraft, type TimingDraft, type TimingKind } from './timing';

const NO_WORKFLOW = '';

const TIMING_KINDS: readonly TimingKind[] = ['now', 'inbox', 'once', 'recurring', 'after_task'];

/** What the dialog opens with — a chat reply handed over with *Send to Build*, for instance. */
export interface NewTaskInitial {
  title?: string;
  brief?: string;
  /** The team, when it is known (the chat's own workflow). */
  workflowId?: Id;
  /** Where the task came from; sent with it so the task links back and reports there. */
  source?: TaskSource;
}

const TYPE_HINT: Readonly<Record<TaskType, string>> = {
  app: 'Changes to the project’s files, made in the task’s own branch.',
  email: 'An email draft you review and accept. Nothing is sent.',
  document: 'A Markdown document, saved into the project folder when you accept it.',
};

/**
 * "New task" (ACE parity P0 design §8, P1 D275–D277): what should change, how you will check it,
 * the team that does it, where it finishes and how far it moves by itself — for an App, an Email
 * draft (to whom) or a Document (saved as which file) — and when it starts: now, in the Inbox, at a
 * time, on a repeating schedule or after another task. A scheduled task is created in the Inbox with
 * its trigger (`start: 'inbox'`, the contract's rule).
 */
export function NewTaskDialog({
  projectId,
  workflows,
  initial = {},
  onClose,
  onCreated,
}: {
  projectId: Id;
  workflows: readonly Workflow[];
  initial?: NewTaskInitial;
  onClose: () => void;
  onCreated?: (task: Task) => void;
}) {
  const create = useCreateTask(projectId);
  const tasks = useTasks(projectId);
  const [title, setTitle] = useState(initial.title ?? '');
  const [brief, setBrief] = useState(initial.brief ?? '');
  const [acceptance, setAcceptance] = useState('');
  const [type, setType] = useState<TaskType>('app');
  const [documentPath, setDocumentPath] = useState('');
  const [emailTo, setEmailTo] = useState('');
  // a chat's own workflow may still be loading: the choice holds until its option arrives
  const [workflowId, setWorkflowId] = useState<Id>(initial.workflowId ?? NO_WORKFLOW);
  const [plannerWorkflowId, setPlannerWorkflowId] = useState<Id>(NO_WORKFLOW);
  const [finishLine, setFinishLine] = useState<FinishLine>(DEFAULT_FINISH_LINE.app);
  const [automation, setAutomation] = useState<TaskAutomation>(DEFAULT_TASK_AUTOMATION);
  const [priority, setPriority] = useState<TaskPriority>('normal');
  const [labels, setLabels] = useState('');
  const [timing, setTiming] = useState<TimingDraft>(() => emptyTiming('inbox'));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [timingError, setTimingError] = useState<{ field: string; message: string }>();

  const waitable = useMemo(
    () => (tasks.data ?? []).filter((task) => task.stage !== 'done'),
    [tasks.data],
  );

  const chooseType = (next: TaskType) => {
    setType(next);
    setFinishLine(DEFAULT_FINISH_LINE[next]);
  };

  /** What only this form knows: the document's file and the email's addresses, field by field. */
  const ownErrors = (): FieldErrors => {
    const own: FieldErrors = {};
    if (type === 'document') {
      const path = ProjectRelativePathSchema.safeParse(documentPath);
      if (documentPath.trim() === '') {
        own['documentPath'] = 'Say where the document is saved, like docs/notes.md.';
      } else if (!path.success) {
        own['documentPath'] =
          path.error.issues[0]?.message ??
          'must be a relative path inside the project folder, like docs/notes.md';
      }
    }
    if (type === 'email') {
      const bad = parseAddresses(emailTo).filter(
        (address) => !EmailAddressSchema.safeParse(address).success,
      );
      if (bad.length > 0) {
        own['emailTo'] = `Not an email address: ${bad.join(', ')}. Separate addresses with commas.`;
      }
    }
    return own;
  };

  const submit = () => {
    const when = triggerFromDraft(timing);
    setTimingError(when.ok ? undefined : { field: when.field, message: when.message });
    const own = ownErrors();
    const body: CreateTaskRequest = {
      title: title.trim(),
      ...(brief.trim() === '' ? {} : { brief: brief.trim() }),
      ...(acceptance.trim() === '' ? {} : { acceptance: acceptance.trim() }),
      type,
      ...(workflowId === NO_WORKFLOW ? {} : { workflowId }),
      ...(plannerWorkflowId === NO_WORKFLOW ? {} : { plannerWorkflowId }),
      finishLine,
      automation,
      priority,
      labels: parseLabels(labels),
      ...(type === 'document' && documentPath.trim() !== ''
        ? { documentPath: documentPath.trim() }
        : {}),
      ...(type === 'email' ? { emailTo: parseAddresses(emailTo) } : {}),
      ...(initial.source === undefined ? {} : { source: initial.source }),
      start: when.ok ? when.start : 'inbox',
      ...(when.ok && when.trigger !== undefined ? { trigger: when.trigger } : {}),
    };
    const parsed = CreateTaskRequestSchema.safeParse(body);
    const contract = parsed.success ? {} : fieldErrors(parsed.error);
    const all = { ...contract, ...own };
    if (!parsed.success || Object.keys(own).length > 0 || !when.ok) {
      setErrors(all);
      return;
    }
    setErrors({});
    create.mutate(parsed.data, {
      onSuccess: (task) => {
        toast.success(
          when.trigger !== undefined
            ? `Task #${task.number} scheduled`
            : when.start === 'now'
              ? `Task #${task.number} started`
              : `Task #${task.number} added to the Inbox`,
        );
        onCreated?.(task);
        onClose();
      },
    });
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    submit();
  };

  const submitLabel =
    timing.kind === 'now' ? 'Start now' : timing.kind === 'inbox' ? 'Add to Inbox' : 'Schedule';

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-[calc(100vw-2rem)] overflow-y-auto sm:max-w-2xl">
        <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>New task</DialogTitle>
            <DialogDescription>
              Say what should be done and how you will check it. Nothing reaches the project, and
              nothing is sent, until you review it.
            </DialogDescription>
          </DialogHeader>

          {initial.source !== undefined && (
            <p
              data-testid="new-task-source"
              className="rounded-field border border-border bg-sunken px-3 py-2 font-human text-xs text-fg-soft"
            >
              From {initial.source.kind === 'schedule' ? 'a schedule' : 'a chat'}
              {initial.source.label === undefined ? '' : ` with ${initial.source.label}`}. The task
              links back to it.
            </p>
          )}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="task-title">Title</Label>
            <Input
              id="task-title"
              value={title}
              maxLength={TASK_TITLE_MAX}
              autoFocus
              aria-invalid={errors['title'] ? true : undefined}
              aria-describedby={errors['title'] ? 'task-title-error' : undefined}
              onChange={(event) => setTitle(event.target.value)}
            />
            <FieldError
              id="task-title-error"
              message={errors['title'] && 'Give the task a title.'}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="task-brief">Brief</Label>
            <Textarea
              id="task-brief"
              rows={4}
              value={brief}
              maxLength={TASK_BRIEF_MAX}
              placeholder="What should be done, in your words."
              onChange={(event) => setBrief(event.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="task-acceptance">How you will check it</Label>
            <Textarea
              id="task-acceptance"
              rows={2}
              value={acceptance}
              maxLength={TASK_BRIEF_MAX}
              placeholder="e.g. searching “cafe” finds “Café Nord”"
              onChange={(event) => setAcceptance(event.target.value)}
            />
          </div>

          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1.5 text-sm font-medium">Type</legend>
            <div className="flex flex-wrap gap-2">
              {TASK_TYPES.map((option) => (
                <label
                  key={option}
                  className={cn(
                    'flex cursor-pointer items-center gap-2 rounded-field border border-border px-3 py-1.5 font-human text-sm',
                    type === option && 'border-fg-muted bg-card',
                  )}
                >
                  <input
                    type="radio"
                    name="task-type"
                    value={option}
                    checked={type === option}
                    onChange={() => chooseType(option)}
                  />
                  {TYPE_LABEL[option]}
                </label>
              ))}
            </div>
            <p className="text-xs text-fg-muted">{TYPE_HINT[type]}</p>
          </fieldset>

          {type === 'document' && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="task-document-path">Save as</Label>
              <Input
                id="task-document-path"
                value={documentPath}
                placeholder="docs/notes.md"
                className="font-machine"
                aria-invalid={errors['documentPath'] ? true : undefined}
                aria-describedby="task-document-path-hint"
                onChange={(event) => setDocumentPath(event.target.value)}
              />
              <p id="task-document-path-hint" className="text-xs text-fg-muted">
                A path inside the project folder. Accept never overwrites an existing file.
              </p>
              <FieldError id="task-document-path-error" message={errors['documentPath']} />
            </div>
          )}

          {type === 'email' && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="task-email-to">To</Label>
              <Input
                id="task-email-to"
                value={emailTo}
                placeholder="ann@example.com, bo@example.com"
                aria-invalid={errors['emailTo'] ? true : undefined}
                aria-describedby="task-email-to-hint"
                onChange={(event) => setEmailTo(event.target.value)}
              />
              <p id="task-email-to-hint" className="text-xs text-fg-muted">
                Comma separated. The draft is accepted for them; ACE does not send it.
              </p>
              <FieldError id="task-email-to-error" message={errors['emailTo']} />
            </div>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="task-team">Team</Label>
              <select
                id="task-team"
                className={selectClass}
                value={workflowId}
                onChange={(event) => setWorkflowId(event.target.value)}
              >
                <option value={NO_WORKFLOW}>No team yet</option>
                {workflows.map((workflow) => (
                  <option key={workflow.id} value={workflow.id}>
                    {workflow.name}
                  </option>
                ))}
              </select>
              <p className="text-xs text-fg-muted">
                The project workflow that does the work. Needed before work can start.
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="task-planner">Planner</Label>
              <select
                id="task-planner"
                className={selectClass}
                value={plannerWorkflowId}
                onChange={(event) => setPlannerWorkflowId(event.target.value)}
              >
                <option value={NO_WORKFLOW}>No planner — write the plan yourself</option>
                {workflows.map((workflow) => (
                  <option key={workflow.id} value={workflow.id}>
                    {workflow.name}
                  </option>
                ))}
              </select>
              <p className="text-xs text-fg-muted">
                Optional: a workflow that writes the plan first.
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="task-finish-line">Finish line</Label>
              <select
                id="task-finish-line"
                className={selectClass}
                value={finishLine}
                onChange={(event) => setFinishLine(event.target.value as FinishLine)}
              >
                {FINISH_LINES_BY_TYPE[type].map((line) => (
                  <option
                    key={line}
                    value={line}
                    disabled={FINISH_LINES_UNAVAILABLE[line] !== undefined}
                  >
                    {finishLineOption(line)}
                  </option>
                ))}
              </select>
              <FieldError id="task-finish-line-error" message={errors['finishLine']} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="task-priority">Priority</Label>
              <select
                id="task-priority"
                className={selectClass}
                value={priority}
                onChange={(event) => setPriority(event.target.value as TaskPriority)}
              >
                {TASK_PRIORITIES.map((option) => (
                  <option key={option} value={option}>
                    {PRIORITY_LABEL[option]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1.5 text-sm font-medium">Automation</legend>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {TASK_AUTOMATIONS.map((option) => (
                <label
                  key={option}
                  className={cn(
                    'flex cursor-pointer flex-col gap-1 rounded-field border border-border p-3',
                    automation === option && 'border-fg-muted bg-card',
                  )}
                >
                  <span className="flex items-center gap-2 font-human text-sm font-medium">
                    <input
                      type="radio"
                      name="task-automation"
                      value={option}
                      checked={automation === option}
                      onChange={() => setAutomation(option)}
                    />
                    {AUTOMATION_META[option].label}
                  </span>
                  <span className="text-xs leading-snug text-fg-muted">
                    {AUTOMATION_META[option].hint}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="task-labels">Labels</Label>
            <Input
              id="task-labels"
              value={labels}
              placeholder="search, ui"
              onChange={(event) => setLabels(event.target.value)}
            />
            <p className="text-xs text-fg-muted">Comma separated.</p>
          </div>

          <TimingFields
            idPrefix="new-task"
            value={timing}
            kinds={TIMING_KINDS}
            tasks={waitable}
            error={timingError}
            onChange={(next) => {
              setTiming(next);
              setTimingError(undefined);
            }}
          />

          {create.error && (
            <p role="alert" className="text-sm text-danger">
              {create.error.message}
            </p>
          )}

          <DialogFooter className="gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending}>
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
