import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Node, NodeRun, Run } from '@ace/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../db.js';
import { DOMAIN_MIGRATION_ID, FORGE_TERMINAL_MIGRATION_ID, MIGRATIONS } from '../migrations.js';
import { SqliteRepository } from '../repository.js';
import { makeInputNode, makeProject, makeWorkflow, scope } from './fixtures.js';

/* Domain's storage (D305, D308, D309, D312, D314): one migration, and every new field round-trips. */

const BEFORE = MIGRATIONS.slice(
  0,
  MIGRATIONS.findIndex((migration) => migration.id === DOMAIN_MIGRATION_ID),
);
const NOW = '2026-10-10T10:00:00.000Z';
const RUN_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0RN55';
const NODE_RUN_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0NRN5';
const MESSAGE_ID = '01JBXQ8Z9KQ4R7N2VWXYZ0MSG1';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ace-domain-'));
  path = join(dir, 'ace.sqlite');
});
afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows can hold the WAL a moment longer; the OS reclaims temp itself.
  }
});

const columnsOf = (sqlite: ReturnType<typeof openDatabase>['sqlite'], table: string): string[] =>
  (sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

describe('Domain migration', () => {
  it('adds the columns and the run index; a database from before it upgrades in place', () => {
    const before = openDatabase({ path, migrations: BEFORE });
    before.sqlite.close();

    const after = openDatabase({ path });
    expect(after.appliedMigrations).toEqual([DOMAIN_MIGRATION_ID, FORGE_TERMINAL_MIGRATION_ID]);
    expect(columnsOf(after.sqlite, 'nodes')).toContain('handle');
    expect(columnsOf(after.sqlite, 'node_runs')).toContain('trigger');
    expect(columnsOf(after.sqlite, 'runs')).toEqual(
      expect.arrayContaining(['blocked_reason', 'domain', 'goal']),
    );
    const indexes = after.sqlite.prepare("PRAGMA index_list('events')").all() as { name: string }[];
    expect(indexes.map((index) => index.name)).toContain('events_run_idx');
    after.sqlite.close();
  });
});

describe('Domain fields round-trip', () => {
  it('a node handle, a run goal and Domain config, a blocked reason, a turn trigger', async () => {
    const db = openDatabase({ path });
    const repository = new SqliteRepository(db.db, db.sqlite);
    const project = makeProject({ folderPath: dir });
    await repository.projects.create(scope, project);
    const workflow = makeWorkflow(project.id);
    await repository.workflows.create(scope, workflow);

    const node: Node = { ...makeInputNode(workflow.id), handle: 'brief' };
    await repository.nodes.insert(scope, node);
    expect((await repository.nodes.listByWorkflow(scope, workflow.id))[0]?.handle).toBe('brief');
    await repository.nodes.update(scope, { ...node, handle: undefined } as Node);
    expect((await repository.nodes.listByWorkflow(scope, workflow.id))[0]?.handle).toBeUndefined();

    const run: Run = {
      id: RUN_ID,
      workflowId: workflow.id,
      projectId: project.id,
      status: 'RUNNING',
      snapshot: { version: 1, nodes: [node], edges: [] },
      inputs: {},
      preflightIssues: [],
      totals: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
      startedAt: NOW,
      goal: 'Write a tagline',
      domain: { routing: 'manual', loopGuardLimit: 4, tokenBudget: 5000, stayOpen: true },
    };
    await repository.runs.create(scope, run);
    expect(await repository.runs.get(scope, RUN_ID)).toMatchObject({
      goal: 'Write a tagline',
      domain: { routing: 'manual', loopGuardLimit: 4, tokenBudget: 5000, stayOpen: true },
    });

    await repository.runs.update(scope, RUN_ID, {
      status: 'BLOCKED',
      blockedReason: 'BUDGET_EXCEEDED',
      domain: { routing: 'manual', loopGuardLimit: 4, tokenBudget: 9000, stayOpen: true },
    });
    const blocked = await repository.runs.get(scope, RUN_ID);
    expect(blocked).toMatchObject({ status: 'BLOCKED', blockedReason: 'BUDGET_EXCEEDED' });
    expect(blocked?.domain?.tokenBudget).toBe(9000);
    // D305: a run BLOCKED mid-run is still going — crash recovery must find it.
    expect((await repository.runs.listActive(scope)).map((each) => each.id)).toEqual([RUN_ID]);

    await repository.runs.update(scope, RUN_ID, { status: 'RUNNING', blockedReason: null });
    expect((await repository.runs.get(scope, RUN_ID))?.blockedReason).toBeUndefined();

    const nodeRun: NodeRun = {
      id: NODE_RUN_ID,
      runId: RUN_ID,
      nodeId: node.id,
      iteration: 1,
      attempt: 2,
      status: 'READY',
      trigger: { kind: 'instruction', messageIds: [MESSAGE_ID] },
      inputEnvelopes: [],
      usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
      verdicts: [],
      toolCalls: [],
    };
    await repository.nodeRuns.create(scope, nodeRun);
    expect((await repository.nodeRuns.get(scope, NODE_RUN_ID))?.trigger).toEqual({
      kind: 'instruction',
      messageIds: [MESSAGE_ID],
    });
    db.sqlite.close();
  });
});
