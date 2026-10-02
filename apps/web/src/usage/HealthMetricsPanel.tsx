import { ERROR_KINDS, type HealthMetrics } from '@ace/contracts';
import { Button } from '@ace/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
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
 * on demand.
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
      className="flex flex-col gap-3"
      data-testid="health-metrics"
      aria-labelledby="health-h"
    >
      <div className="flex items-center gap-2">
        <h2 id="health-h" className="font-human text-sm font-semibold">
          Health
        </h2>
        {data && (
          <span className="font-machine text-[11px] text-fg-muted" data-testid="health-since">
            since <time dateTime={data.since}>{new Date(data.since).toLocaleString()}</time>
          </span>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-auto h-7 gap-1 px-2"
          onClick={() => void health.refetch()}
          disabled={health.isFetching}
          data-testid="health-refresh"
        >
          <RefreshCw aria-hidden className="size-3.5" />
          Refresh
        </Button>
      </div>

      {health.isError ? (
        <p role="alert" className="text-sm text-[var(--color-status-FAILED)]">
          Could not load health metrics: {health.error.message}
        </p>
      ) : data === undefined ? (
        <p className="text-sm text-fg-muted">Loading…</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
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
              <p className="text-xs text-fg-muted">No provider has been called yet.</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wide text-fg-muted">
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
                      <td className="text-right font-machine tabular-nums" data-value={p50}>
                        {ms(p50)}
                      </td>
                      <td className="text-right font-machine tabular-nums" data-value={p95}>
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
              <p className="text-xs text-fg-muted">No verdicts yet.</p>
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
    <div className="flex min-w-0 flex-col gap-2 rounded-card border border-border bg-panel p-3">
      <h3 className="font-human text-xs font-semibold uppercase tracking-wide text-fg-muted">
        {title}
      </h3>
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
      <dt className={machine ? 'truncate font-machine text-xs' : 'text-sm'}>{label}</dt>
      <dd className="font-machine text-sm tabular-nums" data-value={value}>
        {value}
      </dd>
    </div>
  );
}
