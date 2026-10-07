import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BundleSchema,
  NodeRunSchema,
  RunSchema,
  SkillListResponseSchema,
  SkillSchema,
  WorkflowGraphResponseSchema,
  type Run,
} from '@ace/contracts';
import { BUILTIN_SKILL_IDS } from '@ace/engine';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startEngine, type RunningEngine } from '../server.js';

/*
 * ACE parity P1 skills on the real engine (D272, D273): the five built-ins are installed at start
 * and only once, a bundle installs its skills and connects none of its servers, and a run's agent
 * is prompted with the skill it enables — frozen at start, so a later edit changes nothing.
 */

let root: string;
let engine: RunningEngine;

const api = async (path: string, init: { method?: string; body?: unknown } = {}) => {
  const response = await fetch(`${engine.url}/api/v1${path}`, {
    method: init.method ?? 'GET',
    headers: { Authorization: `Bearer ${engine.token}`, 'Content-Type': 'application/json' },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? undefined : (JSON.parse(text) as unknown) };
};

const start = () => startEngine({ dataDir: join(root, 'data'), port: 0, env: {} });

const skillsList = async () => SkillListResponseSchema.parse((await api('/skills')).body).items;

async function runToEnd(workflowId: string): Promise<Run> {
  let run = RunSchema.parse((await api(`/workflows/${workflowId}/runs`, { method: 'POST' })).body);
  for (let i = 0; i < 600 && ['PREFLIGHT', 'RUNNING'].includes(run.status); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    run = RunSchema.parse((await api(`/runs/${run.id}`)).body);
  }
  return run;
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'ace-p1-skills-'));
  engine = await start();
});

afterEach(async () => {
  await engine.stop();
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch {
    // Windows can hold the WAL a moment longer.
  }
});

describe('ACE parity P1 — skills on the real engine', () => {
  it('installs the five built-ins at start, once, however often the engine starts', async () => {
    const first = await skillsList();
    expect(first.map((skill) => skill.id).sort()).toEqual(Object.values(BUILTIN_SKILL_IDS).sort());
    expect(first.every((skill) => skill.source === 'builtin')).toBe(true);

    await engine.stop();
    engine = await start();
    expect(await skillsList()).toEqual(first);
  });

  it('imports a bundle: its skills are installed, its plugins are not connected (D273)', async () => {
    const imported = await api('/bundles/import', {
      method: 'POST',
      body: {
        format: 'ace-bundle',
        formatVersion: 1,
        name: 'Docs team',
        skills: [{ name: 'Plain words', instructions: 'Write short sentences.' }],
        mcpServers: [{ name: 'files', transport: 'stdio', command: 'node', args: ['files.js'] }],
      },
    });
    expect(imported.status).toBe(201);
    const bundle = BundleSchema.parse(imported.body);
    expect(bundle.mcpServers).toHaveLength(1);

    const names = (await skillsList()).map((skill) => skill.name);
    expect(names).toContain('Plain words');
    expect((await api('/mcp-servers')).body).toEqual({ items: [] });

    expect((await api(`/bundles/${bundle.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await skillsList()).map((skill) => skill.name)).not.toContain('Plain words');
  });

  it("prompts an agent with the skill it enables, frozen into the run's snapshot", async () => {
    const provider = (
      await api('/providers', { method: 'POST', body: { type: 'mock', name: 'M' } })
    ).body as { id: string };
    await api(`/providers/${provider.id}/refresh-models`, { method: 'POST' });
    const project = (await api('/projects', { method: 'POST', body: { name: 'Skills' } })).body as {
      id: string;
    };
    const { workflow } = (
      await api('/templates/linear-chain/instantiate', {
        method: 'POST',
        body: { projectId: project.id },
      })
    ).body as { workflow: { id: string } };
    const skill = SkillSchema.parse(
      (
        await api('/skills', {
          method: 'POST',
          body: { name: 'House style', instructions: 'Use British spelling.' },
        })
      ).body,
    );

    const graph = WorkflowGraphResponseSchema.parse((await api(`/workflows/${workflow.id}`)).body);
    const agent = graph.nodes.find((node) => node.kind === 'agent')!;
    const patched = await api(`/workflows/${workflow.id}/graph-ops`, {
      method: 'POST',
      body: {
        baseVersion: graph.workflow.version,
        ops: [{ op: 'update_node', nodeId: agent.id, patch: { config: { skillIds: [skill.id] } } }],
      },
    });
    expect(patched.status).toBe(200);

    const run = await runToEnd(workflow.id);
    expect(run.status).toBe('COMPLETE');
    expect(run.snapshot.skills).toEqual([
      { id: skill.id, name: 'House style', version: 1, instructions: 'Use British spelling.' },
    ]);
    const nodeRuns = NodeRunSchema.array().parse((await api(`/runs/${run.id}/node-runs`)).body);
    const prompt = nodeRuns.find((row) => row.nodeId === agent.id)?.prompt?.text ?? '';
    expect(prompt).toContain('## Skills\n### House style\nUse British spelling.\n');

    // Editing the skill afterwards leaves the finished run as it was (BR-04).
    await api(`/skills/${skill.id}`, {
      method: 'PATCH',
      body: { instructions: 'Use US spelling.' },
    });
    expect(RunSchema.parse((await api(`/runs/${run.id}`)).body).snapshot.skills).toEqual(
      run.snapshot.skills,
    );

    // Removing it blocks the next run at pre-flight, naming the agent.
    await api(`/skills/${skill.id}`, { method: 'DELETE' });
    const blocked = await runToEnd(workflow.id);
    expect(blocked.status).toBe('BLOCKED');
    expect(blocked.preflightIssues.map((issue) => [issue.code, issue.nodeId])).toEqual([
      ['missing_skill', agent.id],
    ]);
  });
});
