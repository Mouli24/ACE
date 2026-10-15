import type { BenchTask, Part } from '@ace/contracts';
import { Badge, Button, FIELD_LABEL_CLASS, Input, Label, Textarea, cn } from '@ace/ui';
import { useEffect, useId, useState } from 'react';

import { useBenchTasks, useCreateBenchTask, useFreezeBenchTask, useUpdateBenchTask } from './hooks';
import { CARD, ErrorLine, MUTED_TEXT, Section } from './shared';

/**
 * Tasks (FR-BEN-001, FR-BEN-002): a prompt, its extra text inputs and a rubric for the judge. A
 * draft is edited in place; Freeze stores the content hash and locks it, after which the engine
 * refuses every edit (TC-BEN-001) and the form is read-only.
 */

interface Draft {
  name: string;
  prompt: string;
  /** One text input per block, separated by a line holding only `---`. */
  inputs: string;
  rubric: string;
}

const EMPTY: Draft = { name: '', prompt: '', inputs: '', rubric: '' };
const SEPARATOR = /\n-{3,}\n/;

function inputsToText(parts: readonly Part[]): string {
  return parts
    .filter((part): part is Extract<Part, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n---\n');
}

function textToInputs(text: string, kept: readonly Part[]): Part[] {
  const texts = text
    .split(SEPARATOR)
    .map((block) => block.trim())
    .filter((block) => block !== '')
    .map((block): Part => ({ type: 'text', text: block }));
  // Artifact references set through the API are kept as they are: this form edits text only.
  return [...texts, ...kept.filter((part) => part.type !== 'text')];
}

function toDraft(task: BenchTask): Draft {
  return {
    name: task.name,
    prompt: task.prompt,
    inputs: inputsToText(task.inputs),
    rubric: task.rubric,
  };
}

export function TasksTab() {
  const tasks = useBenchTasks();
  const [selectedId, setSelectedId] = useState<string | 'new'>('new');
  const selected = tasks.data?.find((task) => task.id === selectedId);

  return (
    <div className="grid min-w-0 gap-4 md:grid-cols-[260px_minmax(0,1fr)]">
      <nav aria-label="Bench tasks" className={cn(CARD, 'flex min-w-0 flex-col gap-1 p-2')}>
        <Button
          variant={selectedId === 'new' ? 'default' : 'secondary'}
          size="sm"
          data-testid="bench-task-new"
          onClick={() => setSelectedId('new')}
        >
          New task
        </Button>
        {tasks.isError && <ErrorLine error={tasks.error} />}
        {tasks.data?.length === 0 && <p className={cn(MUTED_TEXT, 'p-2')}>No tasks yet.</p>}
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {tasks.data?.map((task) => (
            <li key={task.id}>
              <button
                type="button"
                data-testid="bench-task-item"
                data-task-id={task.id}
                aria-current={task.id === selectedId}
                onClick={() => setSelectedId(task.id)}
                className={cn(
                  'flex w-full cursor-pointer items-center justify-between gap-2 rounded-[8px] border-none bg-transparent px-2 py-[6px] text-left text-[12.5px] text-[var(--ink)] hover:bg-[var(--hover)]',
                  task.id === selectedId && 'bg-[var(--hover)]',
                )}
              >
                <span className="min-w-0 truncate">{task.name}</span>
                <Badge variant={task.status === 'frozen' ? 'accent' : 'outline'}>
                  {task.status}
                </Badge>
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <TaskForm
        key={selected?.id ?? 'new'}
        task={selected}
        onCreated={(task) => setSelectedId(task.id)}
      />
    </div>
  );
}

function TaskForm({
  task,
  onCreated,
}: {
  task: BenchTask | undefined;
  onCreated: (task: BenchTask) => void;
}) {
  const [draft, setDraft] = useState<Draft>(task === undefined ? EMPTY : toDraft(task));
  const create = useCreateBenchTask();
  const update = useUpdateBenchTask();
  const freeze = useFreezeBenchTask();
  const frozen = task?.status === 'frozen';
  const ids = { name: useId(), prompt: useId(), inputs: useId(), rubric: useId() };

  // A refetch after a save brings the stored task back; the form follows it.
  useEffect(() => {
    if (task !== undefined) setDraft(toDraft(task));
  }, [task]);

  const set = (field: keyof Draft) => (value: string) =>
    setDraft((current) => ({ ...current, [field]: value }));
  const canSave = draft.name.trim() !== '' && draft.prompt.trim() !== '' && !frozen;
  const dirty = task === undefined || JSON.stringify(toDraft(task)) !== JSON.stringify(draft);

  const save = () => {
    const body = {
      name: draft.name.trim(),
      prompt: draft.prompt,
      inputs: textToInputs(draft.inputs, task?.inputs ?? []),
      rubric: draft.rubric,
    };
    if (task === undefined) create.mutate(body, { onSuccess: onCreated });
    else update.mutate({ id: task.id, body });
  };

  return (
    <Section title={task === undefined ? 'New task' : task.name} testId="bench-task-form">
      {frozen && (
        <p className={MUTED_TEXT} data-testid="bench-task-frozen-note">
          Frozen {task?.frozenAt === undefined ? '' : new Date(task.frozenAt).toLocaleString()} ·
          content hash{' '}
          <code className="font-machine text-[11px]" data-testid="bench-task-hash">
            {task?.contentHash}
          </code>
          . A frozen task cannot be changed.
        </p>
      )}
      <div className="flex flex-col gap-[7px]">
        <Label htmlFor={ids.name}>Name</Label>
        <Input
          id={ids.name}
          data-testid="bench-task-name"
          value={draft.name}
          readOnly={frozen}
          maxLength={120}
          onChange={(event) => set('name')(event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-[7px]">
        <Label htmlFor={ids.prompt}>Prompt</Label>
        <Textarea
          id={ids.prompt}
          data-testid="bench-task-prompt"
          rows={6}
          value={draft.prompt}
          readOnly={frozen}
          onChange={(event) => set('prompt')(event.target.value)}
        />
        <p className={MUTED_TEXT}>Every Input node of both arms reads this first.</p>
      </div>
      <div className="flex flex-col gap-[7px]">
        <Label htmlFor={ids.inputs}>Extra text inputs (optional)</Label>
        <Textarea
          id={ids.inputs}
          data-testid="bench-task-inputs"
          rows={4}
          value={draft.inputs}
          readOnly={frozen}
          onChange={(event) => set('inputs')(event.target.value)}
        />
        <p className={MUTED_TEXT}>
          Each input is handed on after the prompt. Separate inputs with a line holding only ---.
        </p>
      </div>
      <div className="flex flex-col gap-[7px]">
        <Label htmlFor={ids.rubric}>Rubric for the judge</Label>
        <Textarea
          id={ids.rubric}
          data-testid="bench-task-rubric"
          rows={4}
          value={draft.rubric}
          readOnly={frozen}
          onChange={(event) => set('rubric')(event.target.value)}
        />
      </div>
      <ErrorLine error={create.error ?? update.error ?? freeze.error} />
      {!frozen && (
        <div className="flex flex-wrap gap-2">
          <Button
            data-testid="bench-task-save"
            disabled={!canSave || !dirty || create.isPending || update.isPending}
            onClick={save}
          >
            {task === undefined ? 'Create draft' : 'Save draft'}
          </Button>
          {task !== undefined && (
            <Button
              variant="outline"
              data-testid="bench-task-freeze"
              disabled={dirty || freeze.isPending}
              title={dirty ? 'Save the draft first' : undefined}
              onClick={() => freeze.mutate(task.id)}
            >
              Freeze
            </Button>
          )}
        </div>
      )}
      {!frozen && task !== undefined && (
        <p className={cn(FIELD_LABEL_CLASS, 'normal-case')}>
          Freezing stores a hash of the task and locks it for good: only frozen tasks can be
          measured.
        </p>
      )}
    </Section>
  );
}
