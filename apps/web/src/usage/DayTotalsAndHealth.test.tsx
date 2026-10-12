import { ERROR_KINDS } from '@ace/contracts';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { api } from '../app/api';
import { getSocket, startSocket, stopSocket } from '../app/socket';
import { newId } from '../lib/ulid';
import { createFakeWebSocket } from '../mocks/fake-socket';
import { seedUsage } from '../mocks/seeds-round5';
import { installMatchMedia, uninstallMatchMedia } from '../responsive/test-support';
import { db, installMockServer, queryClient, renderApp } from '../test/app';
import { formatCompact, formatUsd, startOfUtcDay, utcDate } from './format';

installMockServer();

afterEach(() => stopSocket());

function openSocket(workflowId: string) {
  startSocket({
    token: 'mock',
    queryClient,
    url: 'ws://mock.local/ws',
    WebSocket: createFakeWebSocket(db) as unknown as typeof WebSocket,
  });
  getSocket()!.subscribe({ scope: 'workflow', id: workflowId });
}

/** A failed node run with a provider error and two verdicts, on top of the seeded history. */
function addFailure(seeded: ReturnType<typeof seedUsage>) {
  const base = db.allNodeRuns().find((nr) => nr.runId === seeded.runIds[0])!;
  const id = newId();
  const at = new Date().toISOString();
  db.upsertNodeRun({
    ...base,
    id,
    status: 'FAILED',
    error: { kind: 'provider', code: 'upstream_5xx', message: 'down', retryable: true },
    verdicts: [
      {
        id: newId(),
        nodeRunId: id,
        point: 'input',
        checkType: 'pii',
        action: 'warn',
        passed: false,
        reason: 'email',
        at,
      },
      {
        id: newId(),
        nodeRunId: id,
        point: 'input',
        checkType: 'pii',
        action: 'warn',
        passed: false,
        reason: 'phone',
        at,
      },
    ],
  });
}

/** At phone width the day's totals sit at the top of the header's menu (D330). */
async function openPhoneMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByTestId('topbar-menu'));
}

describe('FR-OBS-002 day totals in the phone header’s menu', () => {
  beforeEach(() => {
    installMatchMedia(true);
  });
  afterEach(() => uninstallMatchMedia());

  it('shows today’s tokens and cost from GET /usage, and links to /usage', async () => {
    seedUsage(db, 4);
    const expected = await api().getUsage({
      from: startOfUtcDay().toISOString(),
      groupBy: ['day'],
    });
    const tokens = expected.totals.tokensIn + expected.totals.tokensOut;
    expect(tokens).toBeGreaterThan(0);

    const user = userEvent.setup();
    const { router } = renderApp('/settings');
    await openPhoneMenu(user);
    const chip = await screen.findByTestId('day-totals-chip');
    expect(chip).toHaveTextContent(
      `Today: ${formatCompact(tokens)} tok · ${formatUsd(expected.totals.costUsd)}`,
    );
    expect(chip).toHaveAttribute('data-tokens', String(tokens));
    expect(chip).toHaveAttribute('data-cost', String(expected.totals.costUsd));
    await user.click(chip);
    expect(router.state.location.pathname).toBe('/usage');
  });

  it('takes the day totals a completed run’s usage.updated carries', async () => {
    const seeded = seedUsage(db, 1);
    openSocket(seeded.workflowId);
    const user = userEvent.setup();
    renderApp('/settings');
    await openPhoneMenu(user);
    await screen.findByTestId('day-totals-chip');

    act(() => {
      db.emit({
        type: 'usage.updated',
        scope: 'workflow',
        workflowId: seeded.workflowId,
        payload: {
          runId: seeded.runIds[0],
          totals: { tokensIn: 1, tokensOut: 1, costUsd: 0 },
          dayTotals: {
            day: utcDate(new Date()),
            totals: { tokensIn: 12_000, tokensOut: 345, costUsd: 0.4321 },
          },
        },
      });
    });
    await waitFor(() =>
      expect(screen.getByTestId('day-totals-chip')).toHaveAttribute('data-tokens', '12345'),
    );
    expect(screen.getByTestId('day-totals-chip')).toHaveTextContent('Today: 12.3K tok · $0.4321');
  });
});

describe('FR-OBS-007 health metrics in settings', () => {
  it('shows every number GET /metrics/health answers, with provider names', async () => {
    const seeded = seedUsage(db, 4);
    addFailure(seeded);
    const expected = await api().getHealthMetrics();
    renderApp('/settings');

    const panel = await screen.findByTestId('health-metrics');
    expect(within(panel).getByRole('heading', { name: 'Health' })).toBeInTheDocument();
    await within(panel).findByTestId('health-runs-started');
    for (const key of ['started', 'completed', 'halted', 'blocked'] as const) {
      expect(within(panel).getByTestId(`health-runs-${key}`)).toHaveTextContent(
        String(expected.runs[key]),
      );
    }
    expect(expected.runs.started).toBe(seeded.runIds.length);
    for (const kind of ERROR_KINDS) {
      expect(
        within(within(panel).getByTestId(`health-failures-${kind}`)).getByText(
          String(expected.nodeFailuresByKind[kind]),
        ),
      ).toBeInTheDocument();
    }
    expect(expected.nodeFailuresByKind.provider).toBe(1);

    const latencies = Object.entries(expected.providerLatencyMs);
    expect(latencies).toHaveLength(2);
    for (const [providerId, { p50, p95 }] of latencies) {
      const row = within(panel).getByTestId(`health-latency-${providerId}`);
      expect(row).toHaveTextContent(`${p50} ms`);
      expect(row).toHaveTextContent(`${p95} ms`);
      expect(row).not.toHaveTextContent(providerId);
    }
    expect(within(panel).getByTestId('health-verdicts-pii')).toHaveTextContent('2');
    expect(within(panel).getByTestId('health-since')).toBeInTheDocument();
  });

  it('refreshes on demand and when a run completes', async () => {
    const seeded = seedUsage(db, 2);
    openSocket(seeded.workflowId);
    const user = userEvent.setup();
    renderApp('/settings');
    const started = await screen.findByTestId('health-runs-started');
    expect(started).toHaveTextContent(String(seeded.runIds.length));

    addFailure(seeded);
    await user.click(screen.getByTestId('health-refresh'));
    await waitFor(() =>
      expect(screen.getByTestId('health-failures-provider')).toHaveTextContent('1'),
    );

    const more = seedUsage(db, 1);
    act(() => {
      db.emit({
        type: 'run.completed',
        scope: 'workflow',
        workflowId: seeded.workflowId,
        payload: {
          runId: seeded.runIds[0]!,
          status: 'COMPLETE',
          totals: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
        },
      });
    });
    await waitFor(() =>
      expect(screen.getByTestId('health-runs-started')).toHaveTextContent(
        String(seeded.runIds.length + more.runIds.length),
      ),
    );
  });
});
