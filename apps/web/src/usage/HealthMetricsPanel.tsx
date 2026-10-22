import { ERROR_KINDS, type HealthMetrics } from '@ace/contracts';
import { Button, FIELD_LABEL_CLASS, Icons } from '@ace/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { api } from '../app/api';
import { useProviderNames } from './hooks';
import { useSocketFrames } from './live';

const healthQueryKey = ['metrics', 'health'] as const;

const RUN_COUNTS: readonly { key: keyof HealthMetrics['runs']; label: string }[] = [
  { key: 'started', label: 'Started' },
  { key: 'completed', label: 'Completed' },
  { key: 'halted', label: 'Halted' },
  { key: 'blocked', label: 'Blocked' },
];

const ms = (value: number) => `${Math.round(value)} ms`;

/**
 * `GET /metrics/health` on the settings screen (FR-OBS-007): runs started/completed/halted/blocked,
 * node failures by error kind (every kind, 0 included — D234), provider p50/p95 latency by provider
 * name, and guardrail verdicts by check type, counted since `since`. Refetched when a run ends and
 * on demand. A theme card with an inner box per group (D328).
 */
export function HealthMetricsPanel() {
  const queryClient = useQueryClient();
  const providerNames = useProviderNames();
  const health = useQuery({ queryKey: healthQueryKey, queryFn: () => api().getHealthMetrics() });

  useSocketFrames(['run.completed'], () => {
    void queryClient.invalidateQueries({ queryKey: healthQueryKey });
  });

  const data = health.data;
  const latencies = Object.entries(data?.providerLatencyMs ?? {});
  const verdicts = Object.entries(data?.guardrailVerdictsByType ?? {});

  return (
    <section
      className="flex flex-col gap-3 rounded-[12px] border border-[var(--line)] bg-[var(--surface)] p-4"
      data-testid="health-metrics"
      aria-labelledby="health-h"
    >
      <div className="flex items-center gap-2">
        <h2 id="health-h" className="text-[14px] font-bold">
          Health
        </h2>
        {data && (
          <span className="font-machine text-[10px] text-[var(--muted)]" data-testid="health-since">
            since <time dateTime={data.since}>{new Date(data.since).toLocaleString()}</time>
          </span>
        )}
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="ml-auto"
          onClick={() => void health.refetch()}
          disabled={health.isFetching}
          data-testid="health-refresh"
        >
          <Icons.RotateCw aria-hidden size={12} />
          Refresh
        </Button>
      </div>

      {health.isError ? (
        <p role="alert" className="text-[12px] text-danger">
          Could not load health metrics: {health.error.message}
        </p>
      ) : data === undefined ? (
        <p className="text-[13px] text-[var(--muted)]">Loading…</p>
      ) : (
        <div className="grid gap-[10px] sm:grid-cols-2">
          <Card title="Runs">
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
              {RUN_COUNTS.map(({ key, label }) => (
                <Row key={key} label={label} value={data.runs[key]} testId={`health-runs-${key}`} />
              ))}
            </dl>
          </Card>

          <Card title="Node failures by kind">
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
              {ERROR_KINDS.map((kind) => (
                <Row
                  key={kind}
                  label={kind}
                  value={data.nodeFailuresByKind[kind] ?? 0}
                  testId={`health-failures-${kind}`}
                  machine
                />
              ))}
            </dl>
          </Card>

          <Card title="Provider latency">
            {latencies.length === 0 ? (
              <p className="text-[12px] text-[var(--muted)]">No provider has been called yet.</p>
            ) : (
              <table className="w-full text-[12.5px]">
                <thead>
                  <tr className="text-left font-machine text-[9.5px] uppercase tracking-[0.1em] text-[var(--muted)]">
                    <th scope="col" className="font-medium">
                      Provider
                    </th>
                    <th scope="col" className="text-right font-medium">
                      p50
                    </th>
                    <th scope="col" className="text-right font-medium">
                      p95
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {latencies.map(([providerId, { p50, p95 }]) => (
                    <tr key={providerId} data-testid={`health-latency-${providerId}`}>
                      <td className="max-w-[10rem] truncate">
                        {providerNames.get(providerId) ?? providerId}
                      </td>
                      <td
                        className="text-right font-machine text-[12px] tabular-nums"
                        data-value={p50}
                      >
                        {ms(p50)}
                      </td>
                      <td
                        className="text-right font-machine text-[12px] tabular-nums"
                        data-value={p95}
                      >
                        {ms(p95)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          <Card title="Guardrail verdicts by type">
            {verdicts.length === 0 ? (
              <p className="text-[12px] text-[var(--muted)]">No verdicts yet.</p>
            ) : (
              <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
                {verdicts.map(([type, count]) => (
                  <Row
                    key={type}
                    label={type}
                    value={count}
                    testId={`health-verdicts-${type}`}
                    machine
                  />
                ))}
              </dl>
            )}
          </Card>
        </div>
      )}
    </section>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-[10px] border border-[var(--line)] bg-[var(--soft)] p-3">
      <h3 className={FIELD_LABEL_CLASS}>{title}</h3>
      {children}
    </div>
  );
}

function Row({
  label,
  value,
  testId,
  machine = false,
}: {
  label: string;
  value: number;
  testId: string;
  machine?: boolean;
}) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-2" data-testid={testId}>
      <dt className={machine ? 'truncate font-machine text-[11px]' : 'text-[12.5px]'}>{label}</dt>
      <dd className="font-machine text-[12px] font-medium tabular-nums" data-value={value}>
        {value}
      </dd>
    </div>
  );
}
