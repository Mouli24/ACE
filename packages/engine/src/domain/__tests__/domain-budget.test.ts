import type { RunBlockedPayload, RunTokenBudgetPayload } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { routeApp, send } from '../../__tests__/route-app.js';
import { createRunDriverHarness, deferred } from '../../__tests__/run-driver-harness.js';
import { createDomainRoutes } from '../routes.js';

/*
 * Domain Gate 4 (D7, D305, D313): the run token budget counts input + output, cached included. At
 * 80 % the conversation is warned; at 100 % no new turn starts, the turns in flight finish, and
 * the run is BLOCKED `BUDGET_EXCEEDED` until the budget is raised (or removed) or the run ended.
 */

/** Writer → Review, plus Side on its own, held until the test lets it go. */
async function team(writerUsage: { tokensIn: number; tokensOut: number }) {
  const h = await createRunDriverHarness();
  const writer = h.agentNode('Writer');
  const review = h.agentNode('Review');
  const side = h.agentNode('Side');
  await h.seed([writer, review, side], [h.edge(writer, review)]);
  const release = deferred();
  h.scripts.set('Writer', [{ text: 'Draft.', usage: writerUsage }]);
  h.scripts.set('Side', [
    { text: 'Side note.', hold: release.promise, usage: { tokensIn: 1, tokensOut: 1 } },
  ]);
  return { h, writer, review, side, release };
}

const budgets = (h: { payloads: <T>(type: string) => T[] }) =>
  h.payloads<RunTokenBudgetPayload>('run.token_budget');

describe('D313 the token budget', () => {
  it('warns once at 80 %', async () => {
    const { h, release } = await team({ tokensIn: 60, tokensOut: 10 });
    h.scripts.set('Review', [{ text: 'Fine.', usage: { tokensIn: 5, tokensOut: 5 } }]);
    release.resolve();
    const begun = await h.start({ domain: { tokenBudget: 1_000 } });
    // Writer 70 + Review 10 + Side 2 = 82 of 1,000: nothing to say.
    expect((await begun.done).status).toBe('COMPLETE');
    expect(budgets(h)).toEqual([]);

    const again = await team({ tokensIn: 60, tokensOut: 10 });
    again.h.scripts.set('Review', [{ text: 'Fine.', usage: { tokensIn: 5, tokensOut: 5 } }]);
    again.release.resolve();
    const warned = await again.h.start({ domain: { tokenBudget: 100 } });
    expect((await warned.done).status).toBe('COMPLETE');
    expect(budgets(again.h)).toEqual([
      { runId: warned.run.id, limit: 100, used: expect.any(Number), level: 'WARN' },
    ]);
    expect(budgets(again.h)[0]?.used).toBeGreaterThanOrEqual(80);
  });

  it('at 100 % no new turn starts, the turn in flight finishes, and the run is BLOCKED', async () => {
    const { h, side, release } = await team({ tokensIn: 100, tokensOut: 20 });
    const begun = await h.start({ domain: { tokenBudget: 100 } });
    const runId = begun.run.id;
    await h.waitForEvent('run.blocked');

    expect(budgets(h)).toEqual([{ runId, limit: 100, used: 120, level: 'EXCEEDED' }]);
    expect(h.payloads<RunBlockedPayload>('run.blocked')).toEqual([
      expect.objectContaining({ runId, reason: 'BUDGET_EXCEEDED' }),
    ]);
    const row = await h.runRow(runId);
    expect(row.status).toBe('BLOCKED');
    expect(row.blockedReason).toBe('BUDGET_EXCEEDED');
    expect(row.allowedActions).toEqual(expect.arrayContaining(['resume', 'stop']));

    // Side was already going: it finishes. Review, which the Writer fed, never starts.
    release.resolve();
    await h.waitForState(side.id, 'COMPLETED');
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(h.calls('Review')).toBe(0);
    await h.controls.stop(runId);
  });

  it('raising the budget above what was used resumes the run, and what waited runs', async () => {
    const { h, side, release } = await team({ tokensIn: 100, tokensOut: 20 });
    const begun = await h.start({ domain: { tokenBudget: 100 } });
    const runId = begun.run.id;
    await h.waitForEvent('run.blocked');
    release.resolve();
    await h.waitForState(side.id, 'COMPLETED');

    const snapshot = await h.budget(runId, 1_000);
    expect(snapshot.budget).toEqual({ limit: 1_000, used: 122, level: 'OK' });
    expect((await begun.done).status).toBe('COMPLETE');
    expect(h.calls('Review')).toBe(1);
    expect(budgets(h).map((each) => [each.level, each.limit, each.used])).toEqual([
      ['EXCEEDED', 100, 120],
      ['SET', 1_000, 122],
    ]);
    expect(h.payloads('run.resumed')).toHaveLength(1);
  });

  it('a resume while still over blocks again at once; removing the budget lets it finish', async () => {
    const { h, side, release } = await team({ tokensIn: 100, tokensOut: 20 });
    const begun = await h.start({ domain: { tokenBudget: 100 } });
    const runId = begun.run.id;
    await h.waitForEvent('run.blocked');
    release.resolve();
    await h.waitForState(side.id, 'COMPLETED');

    await h.controls.resume(runId);
    await h.waitForEvent('run.blocked', 2);
    expect(h.calls('Review')).toBe(0);
    expect((await h.runRow(runId)).status).toBe('BLOCKED');

    const snapshot = await h.budget(runId, null);
    expect(snapshot.budget).toBeNull();
    expect((await begun.done).status).toBe('COMPLETE');
    expect(h.calls('Review')).toBe(1);
  });

  it('lowering the budget under what was used blocks a parked run, and End still ends it', async () => {
    const { h, release } = await team({ tokensIn: 2, tokensOut: 3 });
    release.resolve();
    const begun = await h.start({ domain: { stayOpen: true } });
    const runId = begun.run.id;
    await h.waitForEvent('run.parked');

    await h.budget(runId, 5);
    await h.waitForEvent('run.blocked');
    expect(budgets(h).map((each) => each.level)).toEqual(['SET', 'EXCEEDED']);
    expect((await h.runRow(runId)).blockedReason).toBe('BUDGET_EXCEEDED');

    const ended = await h.end(runId);
    expect(ended.status).toBe('COMPLETE');
  });
});

describe('D313 PUT /runs/:runId/budget and GET /runs/:runId/usage', () => {
  it('200 with the usage snapshot; 400 a bad limit; 409 once the run has ended', async () => {
    const { h, release } = await team({ tokensIn: 2, tokensOut: 3 });
    release.resolve();
    const begun = await h.start({ domain: { stayOpen: true } });
    const runId = begun.run.id;
    await h.waitForEvent('run.parked');
    const app = routeApp(createDomainRoutes(() => h.domain));

    const put = await send(app, 'PUT', `/runs/${runId}/budget`, { limit: 1_000 });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ runId, budget: { limit: 1_000, level: 'OK' } });
    expect((await send(app, 'PUT', `/runs/${runId}/budget`, { limit: -5 })).status).toBe(400);

    const got = await send(app, 'GET', `/runs/${runId}/usage`);
    expect(got.status).toBe(200);
    const snapshot = (await got.json()) as {
      perNode: { handle: string }[];
      total: { input: number };
    };
    expect(snapshot.perNode.map((each) => each.handle).sort()).toEqual([
      'review',
      'side',
      'writer',
    ]);
    expect(snapshot.total.input).toBeGreaterThan(0);

    await h.end(runId);
    expect((await send(app, 'PUT', `/runs/${runId}/budget`, { limit: 2_000 })).status).toBe(409);
    // A run that has ended still shows what it used.
    expect((await send(app, 'GET', `/runs/${runId}/usage`)).status).toBe(200);
    expect((await send(app, 'GET', '/runs/01JBXQ8Z9KQ4R7N2VWXYZ0RNXX/usage')).status).toBe(404);
  });
});
