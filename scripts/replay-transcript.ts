/**
 * Print a recorded run's Domain conversation as plain text (D303, Domain Gate 1).
 *
 *   pnpm exec tsx scripts/replay-transcript.ts --list
 *   pnpm exec tsx scripts/replay-transcript.ts --run <runId> [--node <handle>] [--usage] [--check] [--json]
 *
 * Reads the engine's database read-only — `--db <path>`, else `$ACE_DATA_DIR/ace.sqlite`, else
 * `~/.ace/ace.sqlite` — and runs the same pure projection the engine serves Domain from, so what
 * this prints is what Domain shows. `--check` lists what Track shows that the transcript does not:
 * node runs with no message, and event types the projection does not narrate.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import Database from 'better-sqlite3';

import {
  domainContextFor,
  filterForNode,
  projectChat,
  projectUsage,
} from '../packages/engine/src/domain/index.js';
import type { EngineEvent } from '../packages/engine/src/ports/index.js';

type Row = Record<string, unknown>;

const { values } = parseArgs({
  options: {
    db: { type: 'string' },
    run: { type: 'string' },
    node: { type: 'string' },
    list: { type: 'boolean' },
    usage: { type: 'boolean' },
    check: { type: 'boolean' },
    json: { type: 'boolean' },
  },
});

const dbPath =
  values.db ?? join(process.env['ACE_DATA_DIR'] ?? join(homedir(), '.ace'), 'ace.sqlite');
const db = new Database(dbPath, { readonly: true, fileMustExist: true });

const write = (line = ''): void => {
  process.stdout.write(`${line}\n`);
};

if (values.list === true || values.run === undefined) {
  const rows = db
    .prepare(
      `select r.id, r.status, r.started_at,
              (select count(*) from events e where e.run_id = r.id) as events,
              (select count(distinct node_id) from node_runs n where n.run_id = r.id) as nodes
         from runs r order by r.started_at desc limit 20`,
    )
    .all() as Row[];
  write(`Recent runs in ${dbPath}:`);
  for (const row of rows) {
    write(
      `  ${String(row['id'])}  ${String(row['status']).padEnd(8)}  ${String(row['started_at'])}  ${String(row['nodes'])} nodes, ${String(row['events'])} events`,
    );
  }
  process.exit(0);
}

const runId = values.run;
const run = db.prepare('select * from runs where id = ?').get(runId) as Row | undefined;
if (run === undefined) {
  process.stderr.write(`no run ${runId} in ${dbPath}\n`);
  process.exit(1);
}

const snapshot = JSON.parse(String(run['snapshot'])) as {
  nodes: Parameters<typeof domainContextFor>[1];
};
const providerTypes = new Map(
  (db.prepare('select id, type from providers').all() as Row[]).map((row): [string, never] => [
    String(row['id']),
    String(row['type']) as never,
  ]),
);
const context = domainContextFor(runId, snapshot.nodes, providerTypes);

const events: EngineEvent[] = (
  db
    .prepare(
      'select seq, type, workflow_id, run_id, payload, created_at from events where run_id = ? order by seq',
    )
    .all(runId) as Row[]
).map((row) => ({
  seq: Number(row['seq']),
  type: String(row['type']),
  ...(row['workflow_id'] === null ? {} : { workflowId: String(row['workflow_id']) }),
  runId,
  payload: JSON.parse(String(row['payload'])) as unknown,
  createdAt: String(row['created_at']),
}));

let messages = projectChat(events, context);
if (values.node !== undefined) {
  const wanted = values.node.replace(/^@/, '');
  const entry = context.roster.find((each) => each.handle === wanted || each.nodeId === wanted);
  if (entry === undefined) {
    process.stderr.write(
      `no node @${wanted}; roster: ${context.roster.map((each) => `@${each.handle}`).join(' ')}\n`,
    );
    process.exit(1);
  }
  messages = filterForNode(messages, entry.nodeId);
}

if (values.json === true) {
  write(JSON.stringify(messages, null, 2));
  process.exit(0);
}

const who = (nodeId: string | undefined): string => {
  if (nodeId === undefined) return '?';
  const entry = context.roster.find((each) => each.nodeId === nodeId);
  return entry === undefined ? (context.nodes.get(nodeId)?.name ?? nodeId) : `@${entry.handle}`;
};
const time = (at: string): string => at.slice(11, 19);
const quote = (text: string): string => text.replace(/\s+/g, ' ').trim();

write(`Run ${runId} · ${String(run['status'])} · started ${String(run['started_at'])}`);
write(
  `Roster: ${context.roster.map((entry) => `@${entry.handle} (${entry.name}${entry.brain ? ', Brain' : ''})`).join(' · ') || '(no agent or model nodes)'}`,
);
write(`${events.length} events → ${messages.length} messages`);
write();

for (const message of messages) {
  const head = `[${time(message.at)}]`;
  switch (message.type) {
    case 'human': {
      const to = message.to === undefined ? '(goal — every node)' : message.to.map(who).join(', ');
      const delivery = (message.delivery ?? [])
        .map((entry) => `${who(entry.nodeId)}:${entry.state}`)
        .join(' ');
      write(
        `${head} you → ${to}: "${quote(message.text)}"${delivery === '' ? '' : `  [${delivery}]`}`,
      );
      break;
    }
    case 'agent': {
      const turn = message.turn;
      const seconds =
        turn?.durationMs === undefined ? '' : ` ${(turn.durationMs / 1000).toFixed(1)}s`;
      const failure = turn?.failureReason === undefined ? '' : ` ${turn.failureReason}`;
      write(
        `${head} ${who(message.author.nodeId)} turn (${turn?.trigger ?? '?'}, attempt ${turn?.attempt ?? '?'}) ${turn?.outcome ?? '?'}${failure}${seconds}: ${message.text === '' ? '(no output)' : `"${quote(message.text)}"`}${message.textSource === 'auto' ? ' [auto]' : ''}`,
      );
      for (const step of turn?.steps ?? []) write(`           · ${step.label} (${step.status})`);
      for (const artifact of message.artifacts ?? []) {
        write(
          `           ▸ ${artifact.path}${artifact.bytes === null ? '' : ` (${artifact.bytes} bytes)`}`,
        );
      }
      break;
    }
    case 'envelope': {
      const envelope = message.envelope;
      const routing = envelope?.routing === undefined ? '' : ` [${envelope.routing}]`;
      write(
        `${head} ${who(envelope?.from)} → ${(message.to ?? []).map(who).join(', ')}  ${envelope?.kind ?? '?'}${routing}: "${quote(message.text)}"${message.textSource === 'auto' ? ' [auto]' : ''}`,
      );
      break;
    }
    case 'brain':
      write(`${head} Brain: ${message.text}`);
      break;
    default:
      write(`${head} — ${message.text}`);
  }
}

if (values.usage === true) {
  const snapshot = projectUsage(events, context, { models: [] });
  write();
  write(
    `Usage: in ${snapshot.total.input} · out ${snapshot.total.output} · cached ${snapshot.total.cachedInput} · estimated ${(snapshot.total.estimatedShare * 100).toFixed(0)}% · cost ${snapshot.costEst === null ? '—' : `$${snapshot.costEst.usd.toFixed(4)} (${snapshot.costEst.source}${snapshot.costEst.partial ? ', partial' : ''})`}`,
  );
  for (const node of snapshot.perNode) {
    write(
      `  @${node.handle.padEnd(20)} ${node.state.padEnd(9)} in ${String(node.input).padStart(7)} out ${String(node.output).padStart(6)} ${node.source ?? '—'}  ${node.activity}`,
    );
  }
}

if (values.check === true) {
  write();
  write('Check — what Track shows that this transcript does not:');
  const turnIds = new Set(
    messages.flatMap((message) => (message.turn === undefined ? [] : [message.turn.turnId])),
  );
  const nodeRuns = db
    .prepare(
      'select id, node_id, status, attempt from node_runs where run_id = ? order by started_at',
    )
    .all(runId) as Row[];
  // A node run that never started is narrated as a system line about its node (BLOCKED).
  const aboutNode = new Set(
    messages.flatMap((message) =>
      message.type === 'system' && message.author.nodeId !== undefined
        ? [message.author.nodeId]
        : [],
    ),
  );
  const missing = nodeRuns.filter(
    (row) =>
      !turnIds.has(String(row['id'])) &&
      !(String(row['status']) === 'BLOCKED' && aboutNode.has(String(row['node_id']))),
  );
  if (missing.length === 0) write(`  node runs: all ${nodeRuns.length} are narrated.`);
  for (const row of missing) {
    write(
      `  node run ${String(row['id'])} of ${who(String(row['node_id']))} (${String(row['status'])}, attempt ${String(row['attempt'])}) has no message — it never reached RUNNING.`,
    );
  }
  const NARRATED = new Set([
    'run.started',
    'run.completed',
    'run.config',
    'run.paused',
    'run.resumed',
    'run.blocked',
    'run.parked',
    'run.token_budget',
    'node.state',
    'node.output',
    'node.error',
    'node.interrupted',
    'tool.call',
    'edge.transfer',
    'human.message',
    'instruction.state',
    'envelope.sent',
    'envelope.routed',
    'node.approval_required',
    'node.approval_decided',
    'guardrail.verdict',
    'loop.iteration',
  ]);
  const silent = new Map<string, number>();
  for (const event of events) {
    if (!NARRATED.has(event.type)) silent.set(event.type, (silent.get(event.type) ?? 0) + 1);
  }
  if (silent.size === 0) write('  event types: every one is narrated.');
  if (String(run['status']) === 'BLOCKED' && events.every((event) => event.type !== 'node.state')) {
    const issues = JSON.parse(String(run['preflight_issues'])) as {
      code?: string;
      message?: string;
    }[];
    write(
      `  pre-flight issues (${issues.length}) are on the run row, not in any event — Track shows them, the transcript cannot: ${issues.map((issue) => issue.code ?? '?').join(', ')}`,
    );
  }
  for (const [type, count] of silent) {
    const why =
      type === 'usage.updated'
        ? 'shown in the team panel (--usage), not as messages'
        : type === 'message.created'
          ? "the workflow Timeline's own copy of run events, not a run event Domain needs"
          : 'NOT NARRATED';
    write(`  ${type} ×${count}: ${why}`);
  }
}
