import {
  FINISH_LINES_BY_TYPE,
  TASK_AUTOMATIONS,
  TASK_BRIEF_MAX,
  TASK_PLAN_MAX,
  TASK_PRIORITIES,
  type FinishLine,
  type Task,
  type TaskAutomation,
  type TaskPriority,
  type UpdateTaskRequest,
  type Workflow,
} from '@ace/contracts';
import { Button, Checkbox, Input, Label, Textarea, toast } from '@ace/ui';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

import { selectClass } from '../knowledge/fields';
import { useUpdateTask } from './hooks';
import {
  AUTOMATION_META,
  FINISH_LINE_LABEL,
  FINISH_LINES_LATER,
  PRIORITY_LABEL,
  parseLabels,
} from './meta';

const NO_WORKFLOW = '';

/**
 * The Overview tab (ACE parity P0, design §8): the brief, the plan, how it will be checked, and the
 * task's settings — each saved on its own through `PATCH /tasks/:id` as it changes (text on blur, or
 * with the plan's Save button), and shown back as the engine holds it. A Done task is read-only.
 */
export function TaskOverview({ task, workflows }: { task: Task; workflows: readonly Workflow[] }) {
  const update = useUpdateTask(task.id);
  const readOnly = task.stage === 'done';

  const save = (patch: UpdateTaskRequest, what: string): Promise<boolean> =>
    update.mutateAsync(patch).then(
      () => {
        toast.success(`${what} saved`);
        return true;
      },
      (error: unknown) => {
        toast.error(`${what} not saved`, {
          description: error instanceof Error ? error.message : undefined,
        });
        return false;
      },
    );

  return (
    <div className="flex flex-col gap-6" data-testid="task-overview">
      <SavedText
        label="Brief"
        value={task.brief}
        max={TASK_BRIEF_MAX}
        rows={5}
        placeholder="What should be done."
        disabled={readOnly}
        onSave={(brief) => save({ brief }, 'Brief')}
      />
      <SavedText
        label="Plan"
        value={task.plan}
        max={TASK_PLAN_MAX}
        rows={6}
        placeholder="No written plan yet. Write one, or let a planner write it."
        disabled={readOnly}
        withSaveButton
        onSave={(plan) => save({ plan }, 'Plan')}
      />
      <SavedText
        label="How you will check it"
        value={task.acceptance}
        max={TASK_BRIEF_MAX}
        rows={2}
        placeholder="Not stated."
        disabled={readOnly}
        onSave={(acceptance) => save({ acceptance }, 'How to check')}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <SelectField
          label="Team"
          hint="The project workflow that does the work."
          value={task.workflowId ?? NO_WORKFLOW}
          disabled={readOnly}
          onChange={(id) => void save({ workflowId: id === NO_WORKFLOW ? null : id }, 'Team')}
        >
          <option value={NO_WORKFLOW}>No team yet</option>
          {workflows.map((workflow) => (
            <option key={workflow.id} value={workflow.id}>
              {workflow.name}
            </option>
          ))}
        </SelectField>
        <SelectField
          label="Planner"
          hint="Optional: a workflow that writes the plan."
          value={task.plannerWorkflowId ?? NO_WORKFLOW}
          disabled={readOnly}
          onChange={(id) =>
            void save({ plannerWorkflowId: id === NO_WORKFLOW ? null : id }, 'Planner')
          }
        >
          <option value={NO_WORKFLOW}>No planner</option>
          {workflows.map((workflow) => (
            <option key={workflow.id} value={workflow.id}>
              {workflow.name}
            </option>
          ))}
        </SelectField>
        <SelectField
          label="Finish line"
          hint="Where the task is finished."
          value={task.finishLine}
          disabled={readOnly}
          onChange={(line) => void save({ finishLine: line as FinishLine }, 'Finish line')}
        >
          {FINISH_LINES_BY_TYPE[task.type].map((line) => (
            <option key={line} value={line} disabled={FINISH_LINES_LATER.has(line)}>
              {FINISH_LINE_LABEL[line]}
              {FINISH_LINES_LATER.has(line) ? ' (coming later)' : ''}
            </option>
          ))}
        </SelectField>
        <SelectField
          label="Automation"
          hint={AUTOMATION_META[task.automation].hint}
          value={task.automation}
          disabled={readOnly}
          onChange={(automation) =>
            void save({ automation: automation as TaskAutomation }, 'Automation')
          }
        >
          {TASK_AUTOMATIONS.map((option) => (
            <option key={option} value={option}>
              {AUTOMATION_META[option].label}
            </option>
          ))}
        </SelectField>
        <SelectField
          label="Priority"
          value={task.priority}
          disabled={readOnly}
          onChange={(priority) => void save({ priority: priority as TaskPriority }, 'Priority')}
        >
          {TASK_PRIORITIES.map((option) => (
            <option key={option} value={option}>
              {PRIORITY_LABEL[option]}
            </option>
          ))}
        </SelectField>
        <LabelsField
          value={task.labels}
          disabled={readOnly}
          onSave={(labels) => save({ labels }, 'Labels')}
        />
      </div>

      <div className="flex items-center gap-2">
        <Checkbox
          id={`task-run-checks-${task.id}`}
          checked={task.runChecks}
          disabled={readOnly}
          onCheckedChange={(checked) => void save({ runChecks: checked === true }, 'Checks')}
        />
        <Label htmlFor={`task-run-checks-${task.id}`}>
          Run the project’s checks after each work run
        </Label>
      </div>
    </div>
  );
}

/**
 * A text box saved on blur (and, for the plan, with a Save button). It follows the engine's value
 * whenever that changes and the box holds no unsaved draft — a planner run filling the plan shows
 * up without a reload.
 */
function SavedText({
  label,
  value,
  max,
  rows,
  placeholder,
  disabled,
  withSaveButton = false,
  onSave,
}: {
  label: string;
  value: string;
  max: number;
  rows: number;
  placeholder: string;
  disabled: boolean;
  withSaveButton?: boolean;
  onSave: (value: string) => Promise<boolean>;
}) {
  const id = useId();
  const [draft, setDraft] = useState(value);
  // true from the first keystroke until the save settles: the engine's value waits till then
  const [dirty, setDirty] = useState(false);
  const saving = useRef(false);
  useEffect(() => {
    if (!dirty) setDraft(value);
  }, [value, dirty]);

  const commit = () => {
    if (!dirty || saving.current) return;
    if (draft === value) {
      setDirty(false);
      return;
    }
    saving.current = true;
    // saved or refused, the box then shows what the engine holds
    void onSave(draft).then(() => {
      saving.current = false;
      setDirty(false);
    });
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={id}>{label}</Label>
        {withSaveButton && (
          <Button
            size="sm"
            variant="secondary"
            disabled={disabled || !dirty || draft === value}
            onMouseDown={(event) => event.preventDefault()}
            onClick={commit}
          >
            Save {label.toLowerCase()}
          </Button>
        )}
      </div>
      <Textarea
        id={id}
        rows={rows}
        value={draft}
        maxLength={max}
        placeholder={placeholder}
        disabled={disabled}
        className="font-human"
        onChange={(event) => {
          setDraft(event.target.value);
          setDirty(true);
        }}
        onBlur={commit}
      />
    </div>
  );
}

function SelectField({
  label,
  hint,
  value,
  disabled,
  onChange,
  children,
}: {
  label: string;
  hint?: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <select
        id={id}
        className={selectClass}
        value={value}
        disabled={disabled}
        onChange={(event) => {
          if (event.target.value !== value) onChange(event.target.value);
        }}
      >
        {children}
      </select>
      {hint && <p className="text-xs text-fg-muted">{hint}</p>}
    </div>
  );
}

function LabelsField({
  value,
  disabled,
  onSave,
}: {
  value: readonly string[];
  disabled: boolean;
  onSave: (labels: string[]) => Promise<boolean>;
}) {
  const id = useId();
  const joined = value.join(', ');
  const [draft, setDraft] = useState(joined);
  useEffect(() => setDraft(joined), [joined]);

  const commit = () => {
    const labels = parseLabels(draft);
    if (labels.join(', ') === joined) {
      setDraft(joined);
      return;
    }
    void onSave(labels).then((ok) => {
      if (!ok) setDraft(joined);
    });
  };

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>Labels</Label>
      <Input
        id={id}
        value={draft}
        disabled={disabled}
        placeholder="search, ui"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
        }}
      />
      <p className="text-xs text-fg-muted">Comma separated.</p>
    </div>
  );
}
