import type { Run, RunDomainConfig } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import type { EngineEvent } from '../../ports/index.js';
import { pairKey } from '../brain.js';
import { createDomainRegistry } from '../registry.js';
import { RUN, RunLog, WF, agent, envOf, nodeId, runOf, text } from './run-log.js';

/*
 * D323, D310: a run carried on after an engine restart gets back the envelope state its log
 * records — what is held, what was forwarded and not yet taken, the open QUERYs, the loop guard's
 * counts and the Brain's digest.
 */

const nodes = [agent(1, 'Writer'), agent(2, 'Review')];

function runOn(config: Partial<RunDomainConfig> = {}): Run {
  return {
    id: RUN,
    workflowId: WF,
    projectId: '01JBXQ8Z9KQ4R7N2VWXYZ0PRJC',
    status: 'RUNNING',
    snapshot: { version: 1, nodes, edges: [] },
    inputs: {},
    preflightIssues: [],
    totals: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
    startedAt: '2026-10-10T09:00:00.000Z',
    domain: {
      routing: 'supervised',
      loopGuardLimit: 3,
      tokenBudget: null,
      stayOpen: true,
      ...config,
    },
  };
}

function sent(
  log: RunLog,
  env: number,
  kind: string,
  from: number,
  to: number[],
  summary: string,
  run: number,
) {
  return log.push('envelope.sent', {
    runId: RUN,
    envelopeId: envOf(env),
    nodeRunId: runOf(run),
    kind,
    fromNodeId: nodeId(from),
    toNodeIds: to.map(nodeId),
    summary,
    textSource: 'summary',
    artifacts: [],
  });
}

function routed(log: RunLog, env: number, decision: string, by = 'brain', reason?: string) {
  return log.push('envelope.routed', {
    runId: RUN,
    envelopeId: envOf(env),
    decision,
    by,
    ...(reason === undefined ? {} : { reason }),
  });
}

async function reopen(events: EngineEvent[], config: Partial<RunDomainConfig> = {}) {
  const registry = createDomainRegistry({
    bus: { emit: async (event) => event as never },
    repository: { events: { listAfter: async () => events } } as never,
    scope: { workspaceId: 'local' } as never,
  });
  return registry.open(runOn(config));
}

/** Review flagged the writer (forwarded) and the writer asked Review a QUERY the guard held. */
function flaggedThenGuarded(): RunLog {
  const log = new RunLog(nodes).started().config({ stayOpen: true });
  log.turn(1, 1, 'Draft one.');
  log.state(2, 2, 'RUNNING').output(2, 2, text('Check this.')).state(2, 2, 'COMPLETED');
  sent(log, 1, 'FLAG', 2, [1], 'Cite a source.', 2);
  routed(log, 1, 'FORWARDED');
  sent(log, 2, 'QUERY', 1, [2], 'Which source?', 1);
  routed(log, 2, 'HELD', 'brain', 'LOOP_GUARD');
  log.push('run.blocked', {
    runId: RUN,
    reason: 'LOOP_GUARD',
    detail: 'ping-pong',
    nodeIds: [nodeId(1), nodeId(2)].sort(),
  });
  return log;
}

describe('D323 the envelope state comes back from the log', () => {
  it('a forwarded envelope no turn has taken waits for its recipient again, with its body', async () => {
    const domain = await reopen(flaggedThenGuarded().events);
    expect(domain.pendingEnvelopes(nodeId(1))).toEqual([
      expect.objectContaining({
        envelopeId: envOf(1),
        kind: 'FLAG',
        fromNodeId: nodeId(2),
        summary: 'Cite a source.',
        body: 'Check this.',
      }),
    ]);
    expect(domain.nodesWantingTurn()).toContain(nodeId(1));
  });

  it('one a turn already took is not handed out again', async () => {
    const log = flaggedThenGuarded();
    log.state(1, 3, 'RUNNING', { trigger: { kind: 'envelope', envelopeIds: [envOf(1)] } });
    const domain = await reopen(log.events);
    expect(domain.pendingEnvelopes(nodeId(1))).toEqual([]);
  });

  it('what is held stays held, the QUERY stays open, and the pair keeps its count', async () => {
    const domain = await reopen(flaggedThenGuarded().events);
    expect(domain.held(envOf(2))).toMatchObject({
      kind: 'QUERY',
      fromNodeId: nodeId(1),
      fromNodeRunId: runOf(1),
      toNodeIds: [nodeId(2)],
      reason: 'LOOP_GUARD',
    });
    expect(domain.openQueries.get(envOf(2))).toEqual({ from: nodeId(1), to: [nodeId(2)] });
    expect(domain.loopCounts.get(pairKey(nodeId(1), nodeId(2)))).toBe(2);
    expect(domain.digest()).toEqual([
      'FLAG @review → @writer: Cite a source. (FORWARDED)',
      'QUERY @writer → @review: Which source? (HELD)',
    ]);
  });

  it('a resume after the guard reset the pair; a decision since then is not held', async () => {
    const log = flaggedThenGuarded();
    log.push('run.resumed', { runId: RUN });
    routed(log, 2, 'FORWARDED', 'human', 'released by resume');
    const domain = await reopen(log.events);
    expect(domain.loopCounts.get(pairKey(nodeId(1), nodeId(2)))).toBeUndefined();
    expect(domain.held(envOf(2))).toBeUndefined();
    expect(domain.pendingEnvelopes(nodeId(2)).map((each) => each.envelopeId)).toEqual([envOf(2)]);
  });

  it('an answered QUERY is closed', async () => {
    const log = flaggedThenGuarded();
    routed(log, 2, 'FORWARDED', 'human');
    log.push('envelope.sent', {
      runId: RUN,
      envelopeId: envOf(3),
      nodeRunId: runOf(4),
      kind: 'ANSWER',
      fromNodeId: nodeId(2),
      toNodeIds: [nodeId(1)],
      summary: 'The 2026 report.',
      textSource: 'summary',
      inReplyTo: envOf(2),
      artifacts: [],
    });
    const domain = await reopen(log.events);
    expect(domain.openQueries.has(envOf(2))).toBe(false);
  });
});

describe('D313 the token budget comes back from the log', () => {
  const used = (log: RunLog, tokensIn: number, tokensOut: number) =>
    log.push('usage.updated', { runId: RUN, totals: { tokensIn, tokensOut, costUsd: 0 } });

  it('the limit the run had, what it has used, and which thresholds were said', async () => {
    const log = new RunLog(nodes).started().config({ stayOpen: true, tokenBudget: 100 });
    used(log, 70, 15);
    log.push('run.token_budget', { runId: RUN, limit: 100, used: 85, level: 'WARN' });
    const domain = await reopen(log.events, { tokenBudget: 100 });
    expect(domain.budget()).toEqual({ limit: 100, warned: true, exceeded: false });
    expect(domain.usedTokens()).toBe(85);
  });

  it('a limit set after the budget was exceeded starts fresh', async () => {
    const log = new RunLog(nodes).started().config({ stayOpen: true, tokenBudget: 100 });
    used(log, 100, 20);
    log.push('run.token_budget', { runId: RUN, limit: 100, used: 120, level: 'EXCEEDED' });
    log.push('run.token_budget', { runId: RUN, limit: 1000, used: 120, level: 'SET' });
    const domain = await reopen(log.events, { tokenBudget: 1000 });
    expect(domain.budget()).toEqual({ limit: 1000, warned: false, exceeded: false });
    expect(domain.usedTokens()).toBe(120);
  });
});
