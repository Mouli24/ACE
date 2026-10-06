import {
  CreateTaskRequestSchema,
  DEFAULT_FINISH_LINE,
  DEFAULT_TASK_AUTOMATION,
  FINISH_LINES_BY_TYPE,
  TASK_AUTOMATIONS,
  TASK_BRIEF_MAX,
  TASK_PRIORITIES,
  TASK_TITLE_MAX,
  TASK_TYPES,
  type FinishLine,
  type Id,
  type TaskAutomation,
  type TaskPriority,
  type TaskStartMode,
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
import { useState, type FormEvent } from 'react';

import { FieldError, fieldErrors, selectClass, type FieldErrors } from '../knowledge/fields';
import { useCreateTask } from './hooks';
import {
  AUTOMATION_META,
  FINISH_LINE_LABEL,
  FINISH_LINES_LATER,
  PRIORITY_LABEL,
  TYPE_LABEL,
  TYPES_LATER,
  parseLabels,
} from './meta';

const NO_WORKFLOW = '';

/**
 * "New task" (ACE parity P0, design §8): what should change, how you will check it, the team that
 * does it, where it finishes and how far it moves by itself. *Add to Inbox* captures it; *Start now*
 * starts it at once (`start: 'now'`). Only App tasks exist in this step.
 */
export function NewTaskDialog({
  projectId,
  workflows,
  onClose,
}: {
  projectId: Id;
  workflows: readonly Workflow[];
  onClose: () => void;
}) {
  const create = useCreateTask(projectId);
  const [title, setTitle] = useState('');
  const [brief, setBrief] = useState('');
  const [acceptance, setAcceptance] = useState('');
  const [type, setType] = useState<TaskType>('app');
  const [workflowId, setWorkflowId] = useState<Id>(NO_WORKFLOW);
  const [plannerWorkflowId, setPlannerWorkflowId] = useState<Id>(NO_WORKFLOW);
  const [finishLine, setFinishLine] = useState<FinishLine>(DEFAULT_FINISH_LINE.app);
  const [automation, setAutomation] = useState<TaskAutomation>(DEFAULT_TASK_AUTOMATION);
  const [priority, setPriority] = useState<TaskPriority>('normal');
  const [labels, setLabels] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});

  const chooseType = (next: TaskType) => {
    setType(next);
    setFinishLine(DEFAULT_FINISH_LINE[next]);
  };

  const submit = (start: TaskStartMode) => {
    const parsed = CreateTaskRequestSchema.safeParse({
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
      start,
    });
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    setErrors({});
    create.mutate(parsed.data, {
      onSuccess: (task) => {
        toast.success(
          start === 'now'
            ? `Task #${task.number} started`
            : `Task #${task.number} added to the Inbox`,
        );
        onClose();
      },
    });
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    submit('inbox');
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-[calc(100vw-2rem)] overflow-y-auto sm:max-w-2xl">
        <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>New task</DialogTitle>
            <DialogDescription>
              Say what should change and how you will check it. The team does the work in its own
              branch; nothing reaches the project until you review it.
            </DialogDescription>
          </DialogHeader>

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
              {TASK_TYPES.map((option) => {
                const later = TYPES_LATER.has(option);
                return (
                  <label
                    key={option}
                    className={cn(
                      'flex items-center gap-2 rounded-field border border-border px-3 py-1.5 font-human text-sm',
                      type === option && 'border-fg-muted bg-card',
                      later && 'opacity-50',
                    )}
                  >
                    <input
                      type="radio"
                      name="task-type"
                      value={option}
                      checked={type === option}
                      disabled={later}
                      onChange={() => chooseType(option)}
                    />
                    {TYPE_LABEL[option]}
                  </label>
                );
              })}
            </div>
            <p className="text-xs text-fg-muted">
              Email and Document tasks are coming in a later step.
            </p>
          </fieldset>

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
                  <option key={line} value={line} disabled={FINISH_LINES_LATER.has(line)}>
                    {FINISH_LINE_LABEL[line]}
                    {FINISH_LINES_LATER.has(line) ? ' (coming later)' : ''}
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

          {create.error && (
            <p role="alert" className="text-sm text-danger">
              {create.error.message}
            </p>
          )}

          <DialogFooter className="gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="secondary" disabled={create.isPending}>
              Add to Inbox
            </Button>
            <Button type="button" disabled={create.isPending} onClick={() => submit('now')}>
              Start now
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
