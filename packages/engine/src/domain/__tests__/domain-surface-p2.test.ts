import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Node } from '@ace/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  agentNode,
  createHarness,
  createProject,
  createWorkflow,
  graphOps,
} from '../../__tests__/graph-helpers.js';
import { routeApp, send } from '../../__tests__/route-app.js';
import { createRunDriverHarness } from '../../__tests__/run-driver-harness.js';
import {
  assemblePrompt,
  HUMAN_INSTRUCTIONS_SECTION,
  TEAM_GOAL_SECTION,
} from '../../prompts/index.js';
import { createDomainRoutes } from '../routes.js';
import { projectChat } from '../project-chat.js';
import { RunLog, agent } from './run-log.js';

/* Domain Phase 2, around the delivery itself: handles on the graph, the HTTP surface, the prompt. */

describe('D304/D308 handles and the Brain on the graph', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ace-domain-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function workflowWith(...nodes: Node[]) {
    const h = createHarness();
    const project = await createProject(h.app, dir);
    const workflow = await createWorkflow(h.app, project.id);
    const placed = nodes.map((node) => ({ ...node, workflowId: workflow.id }));
    const added = await graphOps(
      h.app,
      workflow.id,
      workflow.version,
      placed.map((node) => ({ op: 'add_node' as const, node })),
    );
    return { h, workflow, version: workflow.version + 1, added, placed };
  }

  it('update_node sets a handle and null takes it back to the default', async () => {
    const writer = agentNode('x');
    const { h, workflow, version, placed } = await workflowWith(writer);
    const id = placed[0]?.id ?? '';

    const set = await graphOps(h.app, workflow.id, version, [
      { op: 'update_node', nodeId: id, patch: { handle: 'scribe' } },
    ]);
    expect(set.status).toBe(200);
    expect(((await set.json()) as { nodes: Node[] }).nodes[0]?.handle).toBe('scribe');

    const cleared = await graphOps(h.app, workflow.id, version + 1, [
      { op: 'update_node', nodeId: id, patch: { handle: null } },
    ]);
    expect(((await cleared.json()) as { nodes: Node[] }).nodes[0]?.handle).toBeUndefined();
  });

  it('refuses a handle two nodes share, and a reserved one', async () => {
    const { h, workflow, version, placed } = await workflowWith(agentNode('x'), agentNode('x'));
    const [first, second] = placed;

    const duplicate = await graphOps(h.app, workflow.id, version, [
      { op: 'update_node', nodeId: first?.id ?? '', patch: { handle: 'scribe' } },
      { op: 'update_node', nodeId: second?.id ?? '', patch: { handle: 'scribe' } },
    ]);
    expect(duplicate.status).toBe(400);
    expect(await duplicate.json()).toMatchObject({
      error: { code: 'validation_failed', details: [{ code: 'duplicate_handle' }] },
    });

    const reserved = await graphOps(h.app, workflow.id, version, [
      { op: 'update_node', nodeId: first?.id ?? '', patch: { handle: 'all' } },
    ]);
    expect(reserved.status).toBe(400);
    expect(await reserved.json()).toMatchObject({
      error: { details: [{ code: 'reserved_handle' }] },
    });
  });

  it('refuses a second Brain', async () => {
    const { h, workflow, version, placed } = await workflowWith(agentNode('x'), agentNode('x'));
    const response = await graphOps(
      h.app,
      workflow.id,
      version,
      placed.map((node) => ({
        op: 'update_node' as const,
        nodeId: node.id,
        patch: { config: { brain: true } },
      })),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { details: [{ code: 'more_than_one_brain' }] },
    });
  });
});

describe('D309/D323 POST /runs/:runId/messages and /end', () => {
  it('201 with the delivery; 400 with the closest handles; 409 once ended', async () => {
    const h = await createRunDriverHarness();
    await h.seed([h.agentNode('Writer')], []);
    const begun = await h.start({ domain: { stayOpen: true } });
    await h.waitForEvent('run.parked');
    const app = routeApp(createDomainRoutes(() => h.domain));
    const runId = begun.run.id;

    const ok = await send(app, 'POST', `/runs/${runId}/messages`, { text: 'Writer, again' });
    expect(ok.status).toBe(201);
    expect(await ok.json()).toMatchObject({ delivery: [{ state: 'PENDING' }] });

    const bad = await send(app, 'POST', `/runs/${runId}/messages`, { text: '@writr hi' });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({
      error: {
        code: 'validation_failed',
        details: { errors: [{ code: 'unknown_handle', suggestions: ['@writer'] }] },
      },
    });

    const empty = await send(app, 'POST', `/runs/${runId}/messages`, { text: '   ' });
    expect(empty.status).toBe(400);

    await h.waitForEvent('run.parked', 2);
    const ended = await send(app, 'POST', `/runs/${runId}/end`);
    expect(ended.status).toBe(200);
    expect(await ended.json()).toMatchObject({ status: 'COMPLETE' });

    const after = await send(app, 'POST', `/runs/${runId}/messages`, { text: 'Writer, more' });
    expect(after.status).toBe(409);
    expect(await after.json()).toMatchObject({ error: { code: 'invalid_run_state' } });
  });

  it('a board-started run cannot be ended (409), and an unknown run is 404', async () => {
    const h = await createRunDriverHarness();
    const hold = new Promise<void>(() => undefined);
    h.scripts.set('Writer', [{ hold }]);
    await h.seed([h.agentNode('Writer')], []);
    const begun = await h.start();
    const app = routeApp(createDomainRoutes(() => h.domain));
    expect((await send(app, 'POST', `/runs/${begun.run.id}/end`)).status).toBe(409);
    expect((await send(app, 'POST', '/runs/01JBXQ8Z9KQ4R7N2VWXYZ0RNXX/end')).status).toBe(404);
    await h.controls.stop(begun.run.id);
  });

  it('an app built without Domain answers 501', async () => {
    const app = routeApp(createDomainRoutes(() => undefined));
    const response = await send(app, 'POST', '/runs/01JBXQ8Z9KQ4R7N2VWXYZ0RNXX/messages', {
      text: 'x',
    });
    expect(response.status).toBe(501);
  });
});

describe('D309 a live run is never re-run beside itself', () => {
  it('rerun and retry on a parked Domain run are 409', async () => {
    const h = await createRunDriverHarness();
    const writer = h.agentNode('Writer');
    await h.seed([writer], []);
    const begun = await h.start({ domain: { stayOpen: true } });
    await h.waitForEvent('run.parked');
    const [row] = await h.nodeRunsOf(begun.run.id, writer.id);

    await expect(h.controls.rerunNode(begun.run.id, writer.id)).rejects.toMatchObject({
      status: 409,
    });
    await expect(
      h.controls.retryNodeRun(row?.id ?? '', { withDownstream: false }),
    ).rejects.toMatchObject({
      status: 409,
    });
    await expect(h.controls.restart(begun.run.id)).rejects.toMatchObject({ status: 409 });
  });
});

describe('D311 the prompt sections', () => {
  const base = {
    instructions: 'Write a tagline.',
    envelopes: [],
    contract: { outputTypes: ['text' as const] },
    iteration: 1,
  };

  it('a prompt without Domain content is byte for byte what it was, with the same version', () => {
    const plain = assemblePrompt(base);
    const empty = assemblePrompt({ ...base, team: { humanInstructions: [] } });
    expect(empty.text).toBe(plain.text);
    expect(empty.version).toBe(plain.version);
    expect(plain.text).not.toContain(TEAM_GOAL_SECTION);
  });

  it('puts the goal and the human instructions right after the node’s own instructions', () => {
    const prompt = assemblePrompt({
      ...base,
      team: {
        goal: 'Launch ACE',
        humanInstructions: ['Use British spelling', 'Keep it under 8 words'],
      },
    });
    const at = (header: string) => prompt.text.indexOf(header);
    expect(at('## Instructions')).toBeLessThan(at(TEAM_GOAL_SECTION));
    expect(at(TEAM_GOAL_SECTION)).toBeLessThan(at(HUMAN_INSTRUCTIONS_SECTION));
    expect(at(HUMAN_INSTRUCTIONS_SECTION)).toBeLessThan(at('## Skills'));
    expect(prompt.text).toContain(`${TEAM_GOAL_SECTION}\nLaunch ACE\n`);
    expect(prompt.text).toContain('1. Use British spelling\n2. Keep it under 8 words');
    expect(prompt.version).not.toBe(assemblePrompt(base).version);
  });

  it('is deterministic: the same team input gives the same bytes', () => {
    const team = { goal: 'g', humanInstructions: ['a'] };
    expect(assemblePrompt({ ...base, team }).text).toBe(assemblePrompt({ ...base, team }).text);
  });
});

describe('D303 a run BLOCKED at pre-flight says why', () => {
  it('words the issues the run.completed now carries', () => {
    const log = new RunLog([agent(1, 'Writer')]).started().push('run.completed', {
      runId: '01JBXQ8Z9KQ4R7N2VWXYZ0RN55',
      status: 'BLOCKED',
      totals: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
      preflightIssues: [
        {
          severity: 'error',
          code: 'provider_missing',
          message: '"Writer" uses a provider that was removed.',
        },
      ],
    });
    expect(projectChat(log.events, log.context()).at(-1)?.text).toBe(
      'Run BLOCKED at pre-flight: "Writer" uses a provider that was removed.',
    );
  });
});
