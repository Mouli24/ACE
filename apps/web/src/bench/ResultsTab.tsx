import { BenchScoreSchema, type Id, type ImportBenchScoresRequest } from '@ace/contracts';
import {
  Badge,
  Button,
  FIELD_LABEL_CLASS,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
  cn,
} from '@ace/ui';
import { useId, useState, type ChangeEvent } from 'react';
import { z } from 'zod';

import {
  downloadBlindExport,
  isLive,
  useBenchExperiment,
  useBenchExperiments,
  useBenchReport,
  useImportBenchScores,
} from './hooks';
import {
  ARM_LABEL,
  ErrorLine,
  MUTED_TEXT,
  Section,
  errorText,
  formatMs,
  formatScore,
  formatUsd,
} from './shared';

/**
 * Results (FR-BEN-005..007): download the blind export — outputs under random labels, no arm, node,
 * model or provider — score it by hand, import the scores as CSV (`label,score,note`) or JSON, and
 * read the report: per task, the mean score per arm and the outcome the locked threshold gives,
 * with tokens, cost and time per arm.
 */

const JsonScoresSchema = z.union([
  z.array(BenchScoreSchema),
  z.object({ scores: z.array(BenchScoreSchema) }),
]);

/** What the pasted or loaded text is: JSON rows when it parses as JSON, CSV otherwise. */
export function scoresBody(text: string): ImportBenchScoresRequest {
  const trimmed = text.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const parsed = JsonScoresSchema.parse(JSON.parse(trimmed));
    return { scores: Array.isArray(parsed) ? parsed : parsed.scores };
  }
  return { csv: trimmed };
}

export function ResultsTab({
  selectedId,
  onSelect,
}: {
  selectedId: Id | undefined;
  onSelect: (id: Id) => void;
}) {
  const experiments = useBenchExperiments();
  const started = (experiments.data ?? []).filter((experiment) => experiment.status !== 'draft');

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex max-w-[420px] flex-col gap-[7px]">
        <span className={FIELD_LABEL_CLASS}>Experiment</span>
        {started.length === 0 ? (
          <p className={MUTED_TEXT}>No experiment has started yet.</p>
        ) : (
          <Select value={selectedId ?? ''} onValueChange={onSelect}>
            <SelectTrigger data-testid="bench-results-experiment" aria-label="Experiment">
              <SelectValue placeholder="Choose an experiment" />
            </SelectTrigger>
            <SelectContent>
              {started.map((experiment) => (
                <SelectItem key={experiment.id} value={experiment.id}>
                  {experiment.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
      {selectedId !== undefined && started.some((e) => e.id === selectedId) && (
        <Results id={selectedId} />
      )}
    </div>
  );
}

function Results({ id }: { id: Id }) {
  const experiment = useBenchExperiment(id);
  const live = isLive(experiment.data);
  const report = useBenchReport(id, live);
  const importScores = useImportBenchScores();
  const [text, setText] = useState('');
  const [parseError, setParseError] = useState<string | undefined>();
  const [exportError, setExportError] = useState<unknown>();
  const textId = useId();

  const name = experiment.data?.name ?? 'experiment';
  const scored = experiment.data?.runs.filter((run) => run.score !== undefined).length ?? 0;
  const done = experiment.data?.runs.filter((run) => run.status === 'done').length ?? 0;

  const loadFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file !== undefined) setText(await file.text());
    event.target.value = '';
  };

  const submit = () => {
    setParseError(undefined);
    let body: ImportBenchScoresRequest;
    try {
      body = scoresBody(text);
    } catch (error) {
      setParseError(`These scores could not be read: ${errorText(error)}`);
      return;
    }
    importScores.mutate({ id, body }, { onSuccess: () => setText('') });
  };

  return (
    <>
      <Section title="Blind judging" testId="bench-blind">
        <p className={MUTED_TEXT}>
          The export holds each finished output under a random label, with the tasks and their
          rubrics — no arm, node, model or provider. The key from label to run stays in the engine.
          {live && ' Runs still going are added to a later export under their own labels.'}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="outline"
            data-testid="bench-blind-export"
            disabled={done === 0}
            onClick={() => {
              setExportError(undefined);
              downloadBlindExport(id, name).catch(setExportError);
            }}
          >
            Download blind export
          </Button>
          <span className={MUTED_TEXT} data-testid="bench-scored-count">
            {scored} of {done} finished runs scored
          </span>
        </div>
        <ErrorLine error={exportError} />

        <div className="flex flex-col gap-[7px]">
          <Label htmlFor={textId}>Scores — CSV with label,score,note or JSON rows</Label>
          <Textarea
            id={textId}
            rows={6}
            className="font-machine text-[12px]"
            data-testid="bench-scores-text"
            placeholder={'label,score,note\nK7Q2M9XA,4,clear and complete'}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <div className="flex flex-wrap items-center gap-3">
            <input
              type="file"
              accept=".csv,.json,text/csv,application/json"
              aria-label="Load scores from a file"
              data-testid="bench-scores-file"
              className="text-[12px]"
              onChange={(event) => void loadFile(event)}
            />
            <Button
              data-testid="bench-scores-import"
              disabled={text.trim() === '' || importScores.isPending}
              onClick={submit}
            >
              Import scores
            </Button>
          </div>
        </div>
        {parseError !== undefined && (
          <p role="alert" className="text-[12px] text-danger">
            {parseError}
          </p>
        )}
        <ErrorLine error={importScores.error} />
        {importScores.data !== undefined && (
          <p role="status" className={MUTED_TEXT} data-testid="bench-scores-result">
            Imported {importScores.data.imported} score
            {importScores.data.imported === 1 ? '' : 's'}.
            {importScores.data.unknownLabels.length > 0 &&
              ` Not imported — labels this experiment never exported: ${importScores.data.unknownLabels.join(', ')}.`}
          </p>
        )}
      </Section>

      <Section title="Report" testId="bench-report">
        {report.isError && <ErrorLine error={report.error} />}
        {report.data === undefined ? (
          <p className={MUTED_TEXT}>Loading the report…</p>
        ) : (
          <>
            <p className={MUTED_TEXT}>
              Locked threshold: {report.data.rules.threshold}. Workflow minus baseline ≥ threshold
              is a win, ≤ −threshold a loss, anything between a partial.
            </p>
            <div className="flex flex-wrap gap-2" data-testid="bench-report-summary">
              <Badge variant="accent">win {report.data.summary.win}</Badge>
              <Badge>partial {report.data.summary.partial}</Badge>
              <Badge variant="danger">loss {report.data.summary.loss}</Badge>
              <Badge variant="outline">pending {report.data.summary.pending}</Badge>
            </div>
            {report.data.tasks.map((task) => (
              <div
                key={task.taskId}
                className="flex min-w-0 flex-col gap-2"
                data-testid="bench-report-task"
                data-outcome={task.outcome ?? 'pending'}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="m-0 text-[13px] font-bold">{task.taskName}</h3>
                  <Badge
                    variant={
                      task.outcome === 'win'
                        ? 'accent'
                        : task.outcome === 'loss'
                          ? 'danger'
                          : task.outcome === undefined
                            ? 'outline'
                            : 'default'
                    }
                  >
                    {task.outcome ?? 'pending scores'}
                  </Badge>
                  {task.difference !== undefined && (
                    <span className={MUTED_TEXT}>difference {formatScore(task.difference)}</span>
                  )}
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[560px] border-collapse text-[12px]">
                    <thead>
                      <tr className="text-left">
                        {[
                          'Arm',
                          'Runs',
                          'Scored',
                          'Mean score',
                          'Tokens in',
                          'Tokens out',
                          'Cost',
                          'Mean time',
                        ].map((h) => (
                          <th
                            key={h}
                            className={cn(
                              FIELD_LABEL_CLASS,
                              'border-b border-[var(--line)] py-2 pr-3',
                            )}
                          >
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {task.arms.map((arm) => (
                        <tr key={arm.arm} data-testid="bench-report-arm" data-arm={arm.arm}>
                          <td className="border-b border-[var(--line)] py-[6px] pr-3">
                            {ARM_LABEL[arm.arm]}
                          </td>
                          <td className="border-b border-[var(--line)] py-[6px] pr-3">
                            {arm.runs}
                          </td>
                          <td className="border-b border-[var(--line)] py-[6px] pr-3">
                            {arm.scored}
                          </td>
                          <td className="border-b border-[var(--line)] py-[6px] pr-3 font-machine">
                            {formatScore(arm.meanScore)}
                          </td>
                          <td className="border-b border-[var(--line)] py-[6px] pr-3 font-machine">
                            {arm.tokensIn}
                          </td>
                          <td className="border-b border-[var(--line)] py-[6px] pr-3 font-machine">
                            {arm.tokensOut}
                          </td>
                          <td className="border-b border-[var(--line)] py-[6px] pr-3 font-machine">
                            {formatUsd(arm.costUsd)}
                          </td>
                          <td className="border-b border-[var(--line)] py-[6px] pr-3 font-machine">
                            {formatMs(arm.meanDurationMs)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </>
        )}
      </Section>
    </>
  );
}
