import type { BenchArm, BenchExperimentStatus, BenchRunStatus } from '@ace/contracts';
import { AceApiError } from '@ace/sdk';
import { Badge } from '@ace/ui';
import type { ReactNode } from 'react';

/** The bench's cards, in the theme of the other uncovered screens (D328). */
export const CARD = 'rounded-[12px] border border-[var(--line)] bg-[var(--surface)]';
export const ERROR_TEXT = 'text-[12px] leading-[1.45] text-danger';
export const MUTED_TEXT = 'text-[12px] leading-[1.45] text-[var(--muted)]';

export const ARM_LABEL: Readonly<Record<BenchArm, string>> = {
  workflow: 'A · workflow',
  baseline: 'B · single-model baseline',
};

const EXPERIMENT_STATUS_LABEL: Readonly<Record<BenchExperimentStatus, string>> = {
  draft: 'draft',
  running: 'running',
  waiting_approval: 'waiting for approval',
  complete: 'complete',
  interrupted: 'interrupted',
};

export function ExperimentStatusBadge({ status }: { status: BenchExperimentStatus }) {
  return (
    <Badge
      variant={
        status === 'waiting_approval' ? 'accent' : status === 'interrupted' ? 'danger' : 'default'
      }
      data-testid="bench-experiment-status"
      data-status={status}
    >
      {EXPERIMENT_STATUS_LABEL[status]}
    </Badge>
  );
}

const RUN_STATUS_LABEL: Readonly<Record<BenchRunStatus, string>> = {
  planned: 'planned',
  running: 'running',
  waiting_approval: 'waiting for approval',
  done: 'done',
  skipped: 'skipped',
};

export function RunStatusBadge({ status }: { status: BenchRunStatus }) {
  return (
    <Badge variant={status === 'waiting_approval' ? 'accent' : 'outline'} data-status={status}>
      {RUN_STATUS_LABEL[status]}
    </Badge>
  );
}

/** What a refusal says, in the engine's own words when it gave any. */
export function errorText(error: unknown): string {
  if (AceApiError.is(error)) return error.message;
  return error instanceof Error ? error.message : String(error);
}

export function ErrorLine({ error }: { error: unknown }) {
  if (error === null || error === undefined) return null;
  return (
    <p role="alert" className={ERROR_TEXT}>
      {errorText(error)}
    </p>
  );
}

export function Section({
  title,
  children,
  testId,
}: {
  title: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <section
      aria-label={title}
      data-testid={testId}
      className={`${CARD} flex min-w-0 flex-col gap-4 p-4`}
    >
      <h2 className="text-[14px] font-bold">{title}</h2>
      {children}
    </section>
  );
}

export const formatUsd = (value: number): string =>
  value === 0 ? '$0' : value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;

export const formatMs = (value: number | undefined): string =>
  value === undefined
    ? '—'
    : value < 1000
      ? `${Math.round(value)} ms`
      : `${(value / 1000).toFixed(1)} s`;

export const formatScore = (value: number | undefined): string =>
  value === undefined ? '—' : String(Math.round(value * 100) / 100);
