import {
  ERROR_KINDS,
  NodeStateSchema,
  type ErrorKind,
  type HealthMetrics,
  type NodeState,
  type RunState,
  type Usage,
  type UsageBucket,
  type UsageGroupBy,
  type UsageQuery,
  type UsageResponse,
} from '@ace/contracts';
import type { Scope, UsageRepository } from '@ace/engine';
import type BetterSqlite3 from 'better-sqlite3';

/**
 * The usage and health read models (round 5 §2.6, FR-OBS-002, 004, 007, Arch §26, §27).
 *
 * Both fold what the engine already records — node runs, runs and verdicts — and both fold it in
 * SQL with `json_extract` over the JSON columns, never by reading every node run into memory. The
 * semantics are D234's and F10's, and the engine's `FakeRepository` folds its in-memory rows the
 * same way, so a route test and SQLite give the same numbers.
 */

/**
 * The SQL each grouping keys by (D234): the provider id and the provider-side model id the node
 * run recorded, the UTC date it started on — `date()` converts an offset to UTC, the day the daily
 * budget counts — and its run's workflow. A missing value keys as '' rather than NULL, as the fake
 * keys a node run whose run is unknown. A fixed table, so no caller text reaches the SQL.
 */
const GROUP_KEY_SQL: Record<UsageGroupBy, string> = {
  provider: `COALESCE(json_extract(nr.model_used, '$.providerId'), '')`,
  model: `COALESCE(json_extract(nr.model_used, '$.modelId'), '')`,
  day: `COALESCE(date(nr.started_at), '')`,
  workflow: `COALESCE(r.workflow_id, '')`,
};

/** Only node runs that called a model, and that started, are counted (D234). */
const COUNTED = `nr.workspace_id = ? AND nr.model_used IS NOT NULL AND nr.started_at IS NOT NULL`;

const USAGE_SUMS = `
  COALESCE(SUM(json_extract(nr.usage, '$.tokensIn')), 0)  AS tokensIn,
  COALESCE(SUM(json_extract(nr.usage, '$.tokensOut')), 0) AS tokensOut,
  COALESCE(SUM(json_extract(nr.usage, '$.costUsd')), 0)   AS costUsd`;

const COMPLETE: RunState = 'COMPLETE';
const HALTED: RunState = 'HALTED';
const BLOCKED: RunState = 'BLOCKED';
const COMPLETED: NodeState = 'COMPLETED';
const FAILED = NodeStateSchema.enum.FAILED;

function emptyUsage(): Usage {
  return { tokensIn: 0, tokensOut: 0, costUsd: 0 };
}

export function createUsageRepository(sqlite: BetterSqlite3.Database): UsageRepository {
  return {
    /**
     * `GET /usage` (D234). `from` is inclusive and `to` exclusive, compared as instants so an
     * offset timestamp sorts where it happened. Buckets are ordered by key, grouping by grouping in
     * `groupBy` order, with SQLite's BINARY collation — plain byte order, so 'Zeta' sorts before
     * 'alpha'. `runs` counts distinct runs, and `totals` is the exact sum of the buckets, added
     * here rather than by a second query so the two can never disagree.
     */
    aggregate: async (scope: Scope, query: UsageQuery): Promise<UsageResponse> => {
      const groupBy = query.groupBy;
      const keys = groupBy.map((by, index) => `${GROUP_KEY_SQL[by]} AS g${index}`);
      const aliases = groupBy.map((_, index) => `g${index}`).join(', ');
      const params: unknown[] = [scope.workspaceId];
      let range = '';
      if (query.from !== undefined) {
        range += ` AND unixepoch(nr.started_at, 'subsec') >= unixepoch(?, 'subsec')`;
        params.push(query.from);
      }
      if (query.to !== undefined) {
        range += ` AND unixepoch(nr.started_at, 'subsec') < unixepoch(?, 'subsec')`;
        params.push(query.to);
      }

      const rows = sqlite
        .prepare(
          `SELECT ${keys.join(', ')}, ${USAGE_SUMS}, COUNT(DISTINCT nr.run_id) AS runs
             FROM node_runs nr
             LEFT JOIN runs r ON r.workspace_id = nr.workspace_id AND r.id = nr.run_id
            WHERE ${COUNTED}${range}
            GROUP BY ${aliases}
            ORDER BY ${aliases}`,
        )
        .all(...params) as Record<string, string | number>[];

      const buckets: UsageBucket[] = rows.map((row) => ({
        key: Object.fromEntries(groupBy.map((by, index) => [by, String(row[`g${index}`])])),
        tokensIn: Number(row['tokensIn']),
        tokensOut: Number(row['tokensOut']),
        costUsd: Number(row['costUsd']),
        runs: Number(row['runs']),
      }));

      const totals = buckets.reduce<Usage>(
        (sum, bucket) => ({
          tokensIn: sum.tokensIn + bucket.tokensIn,
          tokensOut: sum.tokensOut + bucket.tokensOut,
          costUsd: sum.costUsd + bucket.costUsd,
        }),
        emptyUsage(),
      );
      return { buckets, totals };
    },

    /** One UTC day of node runs that called a model — the top bar's day total (§2.8, D234). */
    dayTotals: async (scope: Scope, day: string): Promise<Usage> => {
      const row = sqlite
        .prepare(
          `SELECT ${USAGE_SUMS}
             FROM node_runs nr
            WHERE ${COUNTED} AND date(nr.started_at) = ?`,
        )
        .get(scope.workspaceId, day) as Usage;
      return { tokensIn: row.tokensIn, tokensOut: row.tokensOut, costUsd: row.costUsd };
    },

    /**
     * `GET /metrics/health` (FR-OBS-007, F10). Every `ErrorKind` is present, at 0 when nothing
     * failed that way. Latency is the nearest-rank p50 and p95 of completed node runs' durations
     * per provider, ranked in SQL by window functions: rank ⌈f·n⌉ is `(100·f·n + 99) / 100` in
     * integer arithmetic. `since` is the first recorded run's start, or now when there is none.
     */
    healthCounts: async (scope: Scope): Promise<HealthMetrics> => {
      const runs = sqlite
        .prepare(
          `SELECT count(*) AS started,
                  COALESCE(SUM(status = ?), 0) AS completed,
                  COALESCE(SUM(status = ?), 0) AS halted,
                  COALESCE(SUM(status = ?), 0) AS blocked
             FROM runs WHERE workspace_id = ?`,
        )
        .get(COMPLETE, HALTED, BLOCKED, scope.workspaceId) as HealthMetrics['runs'];

      const nodeFailuresByKind = Object.fromEntries(ERROR_KINDS.map((kind) => [kind, 0])) as Record<
        ErrorKind,
        number
      >;
      // Only a node run that FAILED is a failure: a BLOCKED one carries an error too — kind
      // `workflow`, when its upstream failed — but it did not fail (CLAUDE.md §7, BR-03).
      const failures = sqlite
        .prepare(
          `SELECT json_extract(error, '$.kind') AS kind, count(*) AS n
             FROM node_runs WHERE workspace_id = ? AND status = ? AND error IS NOT NULL
            GROUP BY kind`,
        )
        .all(scope.workspaceId, FAILED) as { kind: string | null; n: number }[];
      for (const { kind, n } of failures) {
        // A kind the contract does not name cannot be reported under it; it is left out.
        if ((ERROR_KINDS as readonly (string | null)[]).includes(kind)) {
          nodeFailuresByKind[kind as ErrorKind] = n;
        }
      }

      const latencies = sqlite
        .prepare(
          `WITH ranked AS (
             SELECT json_extract(model_used, '$.providerId') AS providerId,
                    duration_ms AS ms,
                    ROW_NUMBER() OVER (
                      PARTITION BY json_extract(model_used, '$.providerId') ORDER BY duration_ms
                    ) AS rn,
                    COUNT(*) OVER (PARTITION BY json_extract(model_used, '$.providerId')) AS n
               FROM node_runs
              WHERE workspace_id = ? AND status = ?
                AND model_used IS NOT NULL AND duration_ms IS NOT NULL
           )
           SELECT providerId,
                  MAX(CASE WHEN rn = (n * 50 + 99) / 100 THEN ms END) AS p50,
                  MAX(CASE WHEN rn = (n * 95 + 99) / 100 THEN ms END) AS p95
             FROM ranked
            WHERE providerId IS NOT NULL
            GROUP BY providerId
            ORDER BY providerId`,
        )
        .all(scope.workspaceId, COMPLETED) as { providerId: string; p50: number; p95: number }[];
      const providerLatencyMs: HealthMetrics['providerLatencyMs'] = {};
      for (const { providerId, p50, p95 } of latencies)
        providerLatencyMs[providerId] = { p50, p95 };

      const verdicts = sqlite
        .prepare(
          `SELECT check_type AS checkType, count(*) AS n
             FROM guardrail_verdicts WHERE workspace_id = ?
            GROUP BY check_type ORDER BY check_type`,
        )
        .all(scope.workspaceId) as { checkType: string; n: number }[];
      const guardrailVerdictsByType: Record<string, number> = {};
      for (const { checkType, n } of verdicts) guardrailVerdictsByType[checkType] = n;

      const first = sqlite
        .prepare(
          `SELECT started_at AS startedAt FROM runs WHERE workspace_id = ?
            ORDER BY unixepoch(started_at, 'subsec') ASC, started_at ASC LIMIT 1`,
        )
        .get(scope.workspaceId) as { startedAt: string } | undefined;

      return {
        runs: {
          started: runs.started,
          completed: runs.completed,
          halted: runs.halted,
          blocked: runs.blocked,
        },
        nodeFailuresByKind,
        providerLatencyMs,
        guardrailVerdictsByType,
        since: first?.startedAt ?? new Date().toISOString(),
      };
    },
  };
}
