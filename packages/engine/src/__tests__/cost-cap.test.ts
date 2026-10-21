import type { Node, Verdict } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { createBudgetService } from '../budgets/index.js';
import { check, policy } from '../guardrails/__tests__/fakes.js';
import type { PolicyService } from '../guardrails/policy-service.js';
import { newId } from '../ids.js';
import {
  createRunDriverHarness,
  deferred,
  type RunDriverHarness,
} from './run-driver-harness.js';

/**
 * [audit E-4] The run's cost cap is a hard cap (FR-GRD-008, §2.3, D80).
 *
 * The projection before a call counted only its output allowance, and only against what had
 * already been *recorded* — so parallel branches each saw the cap untouched and all went ahead —
 * and a crossed cap stopped only the dispatch loop: turns already queued for their provider slot
 * still called it. Now the prompt counts too, the projected spend of the calls in flight counts,
 * and a crossed cap closes the run to every call that has not started.
 *
 * The scripted model costs $0.001 in and $0.002 out per 1k tokens, and an agent's default output
 * allowance is 4 096 tokens, so each call projects to about $0.0082.
 */

const PROJECTION = (4096 / 1000) * 0.002;

async function cappedHarness(capUsd: number, providerConcurrency = 20) {
  const capPolicy = policy({
    checks: [
      check({ point: 'cost', type: 'max_cost_per_run', action: 'block', params: { usd: capUsd } }),
    ],
  });
  const policies = { resolve: async () => capPolicy } as unknown as PolicyService;
  return createRunDriverHarness({
    providerConcurrency,
    policies,
    budgets: (repository) =>
      createBudgetService({
        scope: { workspaceId: 'local' },
        projects: repository.projects,
        settings: repository.settings,
        usage: { costUsdForDay: async () => 0 },
        verdicts: {
          recordCheck: async (target, ran, outcome): Promise<Verdict> => ({
            id: newId(),
            nodeRunId: target.nodeRunId,
            point: ran.point,
            checkType: ran.type,
            action: ran.action,
            passed: outcome.passed,
            reason: outcome.reason,
            at: new Date().toISOString(),
          }),
        },
      }),
  });
}

/** Brief → each agent → its own Result, every branch independent of the others. */
async function branches(h: RunDriverHarness, names: string[]): Promise<Record<string, Node>> {
  const brief = h.inputNode();
  const nodes: Node[] = [brief];
  const edges = [];
  const byName: Record<string, Node> = {};
  for (const name of names) {
    const agent = h.agentNode(name);
    const result = h.outputNode(`${name}Result`);
    nodes.push(agent, result);
    edges.push(h.edge(brief, agent), h.edge(agent, result));
    byName[name] = agent;
  }
  await h.seed(nodes, edges);
  return byName;
}

describe('[audit E-4] the run cost cap', () => {
  it('counts the projected spend of calls already in flight: parallel branches cannot all start under it', async () => {
    // Room for one call's projection, not two.
    const h = await cappedHarness(PROJECTION * 1.5);
    const nodes = await branches(h, ['Alpha', 'Beta']);

    const { run, done } = await h.start();
    const ended = await done;

    expect(ended).toMatchObject({ status: 'HALTED', haltReason: 'budget_exceeded' });
    expect(ended.budgetHalt).toMatchObject({ scope: 'run', projected: true });
    expect(h.calls('Alpha') + h.calls('Beta')).toBe(1);
    const [stopped] = await h.nodeRunsOf(run.id, nodes['Beta']!.id);
    expect(stopped?.status).toBe('STOPPED');
  });

  it('a crossed cap parks the turns already queued for a provider slot: they end STOPPED without a call', async () => {
    // Room for all three projections, so all three are dispatched and queue for the one slot.
    const h = await cappedHarness(PROJECTION * 3.5, 1);
    const release = deferred();
    // Alpha answers first and spends far more than projected; Carrier holds the slot meanwhile.
    h.scripts.set('Alpha', [{ text: 'alpha', usage: { tokensIn: 2, tokensOut: 100_000 } }]);
    h.scripts.set('Carrier', [{ text: 'carrier', hold: release.promise }]);
    const nodes = await branches(h, ['Alpha', 'Carrier', 'Queued']);

    const { run, done } = await h.start();
    await h.waitForState(nodes['Carrier']!.id, 'RUNNING');
    await h.waitFor(
      () => h.events.some((event) => event.type === 'usage.updated' && event.runId === run.id),
      "Alpha's spend to be recorded",
    );
    release.resolve();
    const ended = await done;

    expect(ended).toMatchObject({ status: 'HALTED', haltReason: 'budget_exceeded' });
    expect(ended.budgetHalt).toMatchObject({ scope: 'run', projected: false });
    // The call that was running when the cap was crossed finished; the queued one never called.
    expect((await h.nodeRunsOf(run.id, nodes['Carrier']!.id)).map((row) => row.status)).toEqual([
      'COMPLETED',
    ]);
    expect(h.calls('Queued')).toBe(0);
    const [queued] = await h.nodeRunsOf(run.id, nodes['Queued']!.id);
    expect(queued?.status).toBe('STOPPED');
    expect(queued?.error?.message).toContain('cost cap');
  });
});
