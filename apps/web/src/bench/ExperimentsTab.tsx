import {
  BENCH_REPETITIONS_MAX,
  BENCH_REPETITIONS_MIN,
  type BenchExperiment,
  type BenchModelRef,
  type BenchTask,
  type Id,
} from '@ace/contracts';
import {
  Button,
  Checkbox,
  FIELD_LABEL_CLASS,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
  cn,
} from '@ace/ui';
import { useId, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { useProjects } from '../projects/hooks';
import { useModels, useProviders } from '../providers/hooks';
import { useWorkflows } from '../workflows/hooks';
import {
  useBenchExperiment,
  useBenchExperiments,
  useBenchTasks,
  useCreateBenchExperiment,
  useStartBenchExperiment,
  useUpdateBenchExperiment,
} from './hooks';
import {
  ARM_LABEL,
  CARD,
  ErrorLine,
  ExperimentStatusBadge,
  MUTED_TEXT,
  RunStatusBadge,
  Section,
  formatMs,
  formatUsd,
} from './shared';

/**
 * Experiments (FR-BEN-003, FR-BEN-007): arm A is a workflow, arm B the single-model baseline the
 * engine builds from it; tasks × arms × repetitions are planned up front and listed. The outcome
 * notes and the numeric threshold are written here, before the first run, and lock at start —
 * after which the engine refuses an edit (TC-BEN-006) and this screen shows them read-only.
 */

const DEFAULT_MODEL = '__strongest__';
const modelKey = (ref: BenchModelRef): string => `${ref.providerId}::${ref.modelId}`;
const parseModelKey = (key: string): BenchModelRef | undefined => {
  if (key === DEFAULT_MODEL) return undefined;
  const [providerId, ...rest] = key.split('::');
  return providerId === undefined ? undefined : { providerId, modelId: rest.join('::') };
};

export function ExperimentsTab({
  selectedId,
  onSelect,
}: {
  selectedId: Id | undefined;
  onSelect: (id: Id | undefined) => void;
}) {
  const experiments = useBenchExperiments();

  return (
    <div className="grid min-w-0 gap-4 md:grid-cols-[260px_minmax(0,1fr)]">
      <nav aria-label="Experiments" className={cn(CARD, 'flex min-w-0 flex-col gap-1 p-2')}>
        <Button
          variant={selectedId === undefined ? 'default' : 'secondary'}
          size="sm"
          data-testid="bench-experiment-new"
          onClick={() => onSelect(undefined)}
        >
          New experiment
        </Button>
        {experiments.isError && <ErrorLine error={experiments.error} />}
        {experiments.data?.length === 0 && (
          <p className={cn(MUTED_TEXT, 'p-2')}>No experiments yet.</p>
        )}
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {experiments.data?.map((experiment) => (
            <li key={experiment.id}>
              <button
                type="button"
                data-testid="bench-experiment-item"
                data-experiment-id={experiment.id}
                aria-current={experiment.id === selectedId}
                onClick={() => onSelect(experiment.id)}
                className={cn(
                  'flex w-full cursor-pointer flex-col items-start gap-1 rounded-[8px] border-none bg-transparent px-2 py-[6px] text-left text-[12.5px] text-[var(--ink)] hover:bg-[var(--hover)]',
                  experiment.id === selectedId && 'bg-[var(--hover)]',
                )}
              >
                <span className="w-full min-w-0 truncate">{experiment.name}</span>
                <ExperimentStatusBadge status={experiment.status} />
              </button>
            </li>
          ))}
        </ul>
      </nav>
      {selectedId === undefined ? (
        <CreateExperiment onCreated={(experiment) => onSelect(experiment.id)} />
      ) : (
        <ExperimentDetail id={selectedId} />
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Create                                                                      */
/* -------------------------------------------------------------------------- */

function CreateExperiment({ onCreated }: { onCreated: (experiment: BenchExperiment) => void }) {
  const projects = useProjects();
  const tasks = useBenchTasks();
  const create = useCreateBenchExperiment();
  const [name, setName] = useState('');
  const [projectId, setProjectId] = useState<Id | undefined>();
  const [workflowId, setWorkflowId] = useState<Id | undefined>();
  const [taskIds, setTaskIds] = useState<Id[]>([]);
  const [repetitions, setRepetitions] = useState('3');
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [notes, setNotes] = useState('');
  const [threshold, setThreshold] = useState('1');
  const workflows = useWorkflows(projectId);
  const ids = { name: useId(), reps: useId(), notes: useId(), threshold: useId() };

  const frozen = (tasks.data ?? []).filter((task) => task.status === 'frozen');
  const reps = Number(repetitions);
  const limit = Number(threshold);
  const repsValid =
    Number.isInteger(reps) && reps >= BENCH_REPETITIONS_MIN && reps <= BENCH_REPETITIONS_MAX;
  const thresholdValid = Number.isFinite(limit) && limit > 0 && threshold.trim() !== '';
  const canCreate =
    name.trim() !== '' &&
    workflowId !== undefined &&
    taskIds.length > 0 &&
    repsValid &&
    thresholdValid &&
    !create.isPending;

  const toggleTask = (id: Id, on: boolean) =>
    setTaskIds((current) => (on ? [...current, id] : current.filter((t) => t !== id)));

  const submit = () => {
    if (!canCreate || workflowId === undefined) return;
    const baselineModel = parseModelKey(model);
    create.mutate(
      {
        name: name.trim(),
        workflowId,
        taskIds,
        repetitions: reps,
        ...(baselineModel === undefined ? {} : { baselineModel }),
        rules: { notes, threshold: limit },
      },
      { onSuccess: onCreated },
    );
  };

  return (
    <Section title="New experiment" testId="bench-experiment-form">
      <div className="flex flex-col gap-[7px]">
        <Label htmlFor={ids.name}>Name</Label>
        <Input
          id={ids.name}
          data-testid="bench-experiment-name"
          value={name}
          maxLength={120}
          onChange={(event) => setName(event.target.value)}
        />
      </div>

      <fieldset className="flex min-w-0 flex-col gap-[7px]">
        <legend className={cn(FIELD_LABEL_CLASS, 'mb-[7px]')}>Arm A — the workflow</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          <Select
            value={projectId ?? ''}
            onValueChange={(value) => {
              setProjectId(value);
              setWorkflowId(undefined);
            }}
          >
            <SelectTrigger data-testid="bench-experiment-project" aria-label="Project">
              <SelectValue placeholder="Project" />
            </SelectTrigger>
            <SelectContent>
              {projects.data?.map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  {project.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={workflowId ?? ''}
            onValueChange={setWorkflowId}
            disabled={projectId === undefined}
          >
            <SelectTrigger data-testid="bench-experiment-workflow" aria-label="Workflow">
              <SelectValue placeholder="Workflow" />
            </SelectTrigger>
            <SelectContent>
              {workflows.data?.map((workflow) => (
                <SelectItem key={workflow.id} value={workflow.id}>
                  {workflow.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </fieldset>

      <fieldset className="flex min-w-0 flex-col gap-[7px]">
        <legend className={cn(FIELD_LABEL_CLASS, 'mb-[7px]')}>
          Arm B — the single-model baseline
        </legend>
        <ModelSelect value={model} onChange={setModel} testId="bench-experiment-model" />
        <p className={MUTED_TEXT}>
          One Agent with every tool arm A&apos;s agents have, arm A&apos;s project policy and the
          same budget caps. By default it runs on the strongest model arm A uses; you can change it
          until the experiment starts.
        </p>
      </fieldset>

      <fieldset className="flex min-w-0 flex-col gap-[7px]">
        <legend className={cn(FIELD_LABEL_CLASS, 'mb-[7px]')}>Frozen tasks</legend>
        {frozen.length === 0 ? (
          <p className={MUTED_TEXT}>Freeze a task on the Tasks tab first.</p>
        ) : (
          <div className="flex flex-col gap-2" data-testid="bench-experiment-tasks">
            {frozen.map((task) => {
              const id = `bench-experiment-task-${task.id}`;
              return (
                <div key={task.id} className="flex items-center gap-2">
                  <Checkbox
                    id={id}
                    data-testid="bench-experiment-task"
                    checked={taskIds.includes(task.id)}
                    onCheckedChange={(value) => toggleTask(task.id, value === true)}
                  />
                  <label htmlFor={id} className="cursor-pointer text-[12.5px]">
                    {task.name}
                  </label>
                </div>
              );
            })}
          </div>
        )}
      </fieldset>

      <div className="flex flex-col gap-[7px]">
        <Label htmlFor={ids.reps}>
          Repetitions per task and arm ({BENCH_REPETITIONS_MIN}–{BENCH_REPETITIONS_MAX})
        </Label>
        <Input
          id={ids.reps}
          type="number"
          min={BENCH_REPETITIONS_MIN}
          max={BENCH_REPETITIONS_MAX}
          className="w-28"
          data-testid="bench-experiment-reps"
          value={repetitions}
          onChange={(event) => setRepetitions(event.target.value)}
        />
        {repsValid && taskIds.length > 0 && (
          <p className={MUTED_TEXT} data-testid="bench-experiment-planned">
            {taskIds.length} task{taskIds.length === 1 ? '' : 's'} × 2 arms × {reps} ={' '}
            {taskIds.length * 2 * reps} runs, one at a time.
          </p>
        )}
      </div>

      <fieldset className="flex min-w-0 flex-col gap-[7px]">
        <legend className={cn(FIELD_LABEL_CLASS, 'mb-[7px]')}>
          Pre-registered rules — locked at start
        </legend>
        <Label htmlFor={ids.notes}>What you expect, and why</Label>
        <Textarea
          id={ids.notes}
          rows={3}
          data-testid="bench-experiment-notes"
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
        />
        <Label htmlFor={ids.threshold}>Threshold, in score points</Label>
        <Input
          id={ids.threshold}
          type="number"
          min={0}
          step="any"
          className="w-28"
          data-testid="bench-experiment-threshold"
          value={threshold}
          onChange={(event) => setThreshold(event.target.value)}
        />
        <p className={MUTED_TEXT}>
          Per task: the workflow&apos;s mean score minus the baseline&apos;s at least this much is a
          win, at most minus this much a loss, anything between a partial.
        </p>
      </fieldset>

      <ErrorLine error={create.error} />
      <div>
        <Button data-testid="bench-experiment-create" disabled={!canCreate} onClick={submit}>
          Create experiment
        </Button>
      </div>
    </Section>
  );
}

function ModelSelect({
  value,
  onChange,
  testId,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  testId: string;
  disabled?: boolean;
}) {
  const models = useModels({ available: true });
  const providers = useProviders();
  const providerName = (id: Id) => providers.data?.find((p) => p.id === id)?.name ?? id;
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled === true}>
      <SelectTrigger data-testid={testId} aria-label="Baseline model">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={DEFAULT_MODEL}>Arm A&apos;s strongest model</SelectItem>
        {models.data?.items.map((model) => (
          <SelectItem key={model.id} value={modelKey(model)}>
            {providerName(model.providerId)} · {model.displayName}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/* -------------------------------------------------------------------------- */
/* Detail                                                                      */
/* -------------------------------------------------------------------------- */

function ExperimentDetail({ id }: { id: Id }) {
  const experiment = useBenchExperiment(id);
  const tasks = useBenchTasks();
  const providers = useProviders();
  const start = useStartBenchExperiment();
  const update = useUpdateBenchExperiment();

  const taskName = useMemo(() => {
    const byId = new Map((tasks.data ?? []).map((task: BenchTask) => [task.id, task.name]));
    return (taskId: Id) => byId.get(taskId) ?? taskId;
  }, [tasks.data]);

  if (experiment.isError) return <ErrorLine error={experiment.error} />;
  const data = experiment.data;
  if (data === undefined) return <p className={MUTED_TEXT}>Loading the experiment…</p>;

  const draft = data.status === 'draft';
  const done = data.runs.filter((run) => run.status === 'done').length;
  const baseline = data.baselineModel;
  const providerName = (providerId: Id) =>
    providers.data?.find((provider) => provider.id === providerId)?.name ?? providerId;

  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="bench-experiment-detail">
      <Section title={data.name}>
        <div className="flex flex-wrap items-center gap-3">
          <ExperimentStatusBadge status={data.status} />
          <span className={MUTED_TEXT} data-testid="bench-experiment-progress">
            {done} of {data.runs.length} runs done
          </span>
        </div>

        {data.status === 'waiting_approval' && data.pendingApproval !== undefined && (
          <p
            role="status"
            data-testid="bench-experiment-approval"
            className="rounded-[9px] border border-[#ef6b3f] bg-[rgba(239,107,63,0.08)] p-3 text-[12.5px]"
          >
            A bench run is waiting for your approval; the experiment is paused until you answer it.{' '}
            <Link to={`/runs/${data.pendingApproval.runId}`} data-testid="bench-approval-link">
              Open the run
            </Link>
          </p>
        )}

        <dl className="m-0 grid gap-x-4 gap-y-2 text-[12.5px] sm:grid-cols-[180px_minmax(0,1fr)]">
          <dt className={FIELD_LABEL_CLASS}>Arm B model</dt>
          <dd className="m-0" data-testid="bench-experiment-baseline">
            {draft ? (
              <ModelSelect
                value={baseline === undefined ? DEFAULT_MODEL : modelKey(baseline)}
                testId="bench-experiment-baseline-select"
                disabled={update.isPending}
                onChange={(value) => {
                  const ref = parseModelKey(value);
                  if (ref !== undefined) update.mutate({ id, body: { baselineModel: ref } });
                }}
              />
            ) : baseline === undefined ? (
              '—'
            ) : (
              `${providerName(baseline.providerId)} · ${baseline.modelId}`
            )}
          </dd>
          <dt className={FIELD_LABEL_CLASS}>Repetitions</dt>
          <dd className="m-0">{data.repetitions}</dd>
          <dt className={FIELD_LABEL_CLASS}>Threshold</dt>
          <dd className="m-0" data-testid="bench-experiment-rules-threshold">
            {data.rules.threshold} {draft ? '' : '(locked)'}
          </dd>
          <dt className={FIELD_LABEL_CLASS}>Pre-registered notes</dt>
          <dd className="m-0 whitespace-pre-wrap" data-testid="bench-experiment-rules-notes">
            {data.rules.notes === '' ? '—' : data.rules.notes}
          </dd>
          {data.startedAt !== undefined && (
            <>
              <dt className={FIELD_LABEL_CLASS}>Started</dt>
              <dd className="m-0">{new Date(data.startedAt).toLocaleString()}</dd>
            </>
          )}
        </dl>

        <ErrorLine error={start.error ?? update.error} />
        {draft && (
          <div>
            <Button
              data-testid="bench-experiment-start"
              disabled={start.isPending || baseline === undefined}
              onClick={() => start.mutate(id)}
            >
              Start — locks the rules
            </Button>
            {baseline === undefined && (
              <p className={MUTED_TEXT}>Arm A names no model: choose arm B&apos;s model first.</p>
            )}
          </div>
        )}
      </Section>

      <Section title="Planned runs" testId="bench-experiment-plan">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] border-collapse text-[12px]">
            <thead>
              <tr className="text-left">
                {['#', 'Task', 'Arm', 'Rep', 'Status', 'Tokens', 'Cost', 'Time', ''].map((h) => (
                  <th
                    key={h}
                    className={cn(FIELD_LABEL_CLASS, 'border-b border-[var(--line)] py-2 pr-3')}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.runs.map((run) => (
                <tr key={run.id} data-testid="bench-planned-run" data-status={run.status}>
                  <td className="border-b border-[var(--line)] py-[6px] pr-3">{run.order + 1}</td>
                  <td className="border-b border-[var(--line)] py-[6px] pr-3">
                    {taskName(run.taskId)}
                  </td>
                  <td className="border-b border-[var(--line)] py-[6px] pr-3">
                    {ARM_LABEL[run.arm]}
                  </td>
                  <td className="border-b border-[var(--line)] py-[6px] pr-3">{run.rep}</td>
                  <td className="border-b border-[var(--line)] py-[6px] pr-3">
                    <RunStatusBadge status={run.status} />
                  </td>
                  <td className="border-b border-[var(--line)] py-[6px] pr-3 font-machine">
                    {run.record === undefined
                      ? '—'
                      : run.record.usage.tokensIn + run.record.usage.tokensOut}
                  </td>
                  <td className="border-b border-[var(--line)] py-[6px] pr-3 font-machine">
                    {run.record === undefined ? '—' : formatUsd(run.record.usage.costUsd)}
                  </td>
                  <td className="border-b border-[var(--line)] py-[6px] pr-3 font-machine">
                    {formatMs(run.record?.durationMs)}
                  </td>
                  <td className="border-b border-[var(--line)] py-[6px]">
                    {run.runId !== undefined && (
                      <Link to={`/runs/${run.runId}`} data-testid="bench-run-link">
                        Open run
                      </Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </div>
  );
}
