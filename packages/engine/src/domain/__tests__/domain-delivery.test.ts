import type {
  HumanMessagePayload,
  InstructionStatePayload,
  NodeStatePayload,
} from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { HttpError } from '../../gateway/errors.js';
import { createLogger } from '../../logging/index.js';
import { haltActiveRuns } from '../../runs/lifecycle.js';
import {
  createRunDriverHarness,
  deferred,
  httpError,
  scope,
  type RunDriverHarness,
} from '../../__tests__/run-driver-harness.js';

/*
 * Domain Gate 2 (D309, D323–D326): a human message reaches the nodes it names, and only them; it
 * waits for a busy node's next turn, starts an idle node's now, or cuts a turn short; a run started
 * from Domain stays open when its graph finishes; End closes it. All on the scripted provider.
 */

/** A two-node chain Writer → Review, plus the Brain on its own. */
async function team(stayOpen = true): Promise<{
  h: RunDriverHarness;
  ids: { writer: string; review: string; brain: string };
}> {
  const h = await createRunDriverHarness();
  const writer = h.agentNode('Writer');
  const review = h.agentNode('Review');
  const brain = h.agentNode('Director', {}, { brain: true });
  await h.seed([writer, review, brain], [h.edge(writer, review)]);
  void stayOpen;
  return { h, ids: { writer: writer.id, review: review.id, brain: brain.id } };
}

const hasText = (prompts: readonly string[], text: string): boolean =>
  prompts.some((prompt) => prompt.includes(text));

const statesOf = (h: RunDriverHarness, messageId: string, nodeId: string): string[] =>
  h
    .payloads<InstructionStatePayload>('instruction.state')
    .filter((each) => each.messageId === messageId && each.nodeId === nodeId)
    .map((each) => each.state);

/** Rejects with the HttpError the call threw, so a test can read its status and details. */
async function refusal(promise: Promise<unknown>): Promise<HttpError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

async function parked(h: RunDriverHarness, count = 1): Promise<string> {
  const begun = await h.start({ domain: { stayOpen: true } });
  await h.waitForEvent('run.parked', count);
  return begun.run.id;
}

describe('D323 a run started from Domain stays open', () => {
  it('parks instead of completing: RUNNING, with no provider calls while parked', async () => {
    const { h } = await team();
    const runId = await parked(h);
    const calls = h.totalCalls();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(h.totalCalls()).toBe(calls);
    expect((await h.runRow(runId)).status).toBe('RUNNING');
    expect(h.payloads('run.completed')).toHaveLength(0);
    expect(h.payloads('run.parked')).toEqual([{ runId, graph: 'complete' }]);
    expect((await h.runRow(runId)).allowedActions).toContain('end');
  });

  it('naming a finished node while parked runs its turn, re-runs its successors, then parks again', async () => {
    const { h, ids } = await team();
    const runId = await parked(h);
    expect(h.calls('Writer')).toBe(1);
    expect(h.calls('Review')).toBe(1);

    await h.post(runId, 'Writer, make it shorter');
    await h.waitForEvent('run.parked', 2);

    expect(h.calls('Writer')).toBe(2);
    expect(h.calls('Review')).toBe(2);
    const running = h
      .payloads<NodeStatePayload>('node.state')
      .filter((state) => state.status === 'RUNNING' && state.nodeId === ids.writer);
    // A plain dispatch's RUNNING frame carries no trigger, so every existing frame is unchanged.
    expect(running.map((state) => [state.attempt, state.trigger?.kind ?? 'dispatch'])).toEqual([
      [1, 'dispatch'],
      [2, 'instruction'],
    ]);
    expect((await h.runRow(runId)).status).toBe('RUNNING');
  });

  it('End completes the run and drops what is still pending', async () => {
    const { h, ids } = await team();
    const runId = await parked(h);
    const release = deferred();
    h.scripts.set('Writer', [{ text: 'first' }, { text: 'second', hold: release.promise }]);

    await h.post(runId, 'Writer, again');
    await h.waitForState(ids.writer, 'RUNNING', 2);
    const queued = await h.post(runId, 'Writer, and one more after that');

    const ended = await h.end(runId);
    expect(ended.status).toBe('COMPLETE');
    expect(statesOf(h, queued.messageId, ids.writer)).toEqual(['PENDING', 'DROPPED']);
    expect(h.payloads<{ status: string }>('run.completed').map((each) => each.status)).toEqual([
      'COMPLETE',
    ]);
    // The turn End cut short is STOPPED and handed nothing on.
    expect(h.framesOf(ids.writer).at(-1)).toBe('2:STOPPED');
    expect(h.calls('Review')).toBe(1);
  });

  it('a message after End is refused with 409, and nothing is written', async () => {
    const { h } = await team();
    const runId = await parked(h);
    await h.end(runId);
    const before = h.events.length;
    const error = await refusal(h.post(runId, 'Writer, one more'));
    expect(error.status).toBe(409);
    expect(h.events.length).toBe(before);
  });

  it('a run started from the board still completes normally', async () => {
    const { h } = await team();
    const begun = await h.start();
    const done = await begun.done;
    expect(done.status).toBe('COMPLETE');
    expect(h.payloads('run.parked')).toHaveLength(0);
    expect(done.allowedActions).not.toContain('end');
  });

  it('after an engine restart a parked run carries on; a turn that was in flight ends FAILED crash', async () => {
    const { h, ids } = await team();
    const runId = await parked(h);

    // The process "dies" with a turn in flight: the store says Review is RUNNING.
    const [reviewRun] = (await h.nodeRunsOf(runId, ids.review)).slice(-1);
    if (reviewRun === undefined) throw new Error('no review run');
    await h.repository.nodeRuns.update(scope, reviewRun.id, { status: 'RUNNING' });

    const next = await createRunDriverHarness({ repository: h.repository });
    const recovered = await next.recover();
    expect(recovered.reopened).toEqual([runId]);
    expect(recovered.halted).toEqual([]);

    const crashed = await next.repository.nodeRuns.get(scope, reviewRun.id);
    expect(crashed).toMatchObject({
      status: 'FAILED',
      failureReason: 'RUN_FAILED',
      error: { code: 'crash' },
    });
    expect((await next.runRow(runId)).status).toBe('RUNNING');

    // It parks again with nothing called, and still answers.
    await next.waitForEvent('run.parked');
    expect(next.totalCalls()).toBe(0);
    await next.post(runId, 'Review, look again');
    await next.waitForEvent('run.parked', 2);
    expect(next.calls('Review')).toBe(1);
  });
});

describe('[audit E-7] D323 a clean shutdown leaves a Domain run open', () => {
  it('a parked run is not halted by a shutdown, and the next start carries it on', async () => {
    const { h } = await team();
    const runId = await parked(h);

    await h.service.shutdown();
    // What the server does after the drives have unwound.
    expect(
      await haltActiveRuns({
        repository: h.repository,
        scope,
        bus: h.bus,
        logger: createLogger({ level: 'silent', destination: { write: () => undefined } }),
        keepOpen: (run) => run.domain?.stayOpen === true,
      }),
    ).toEqual([]);
    expect((await h.runRow(runId)).status).toBe('RUNNING');
    expect(h.payloads('run.completed')).toHaveLength(0);

    const next = await createRunDriverHarness({ repository: h.repository });
    expect(await next.recover()).toEqual({ halted: [], reopened: [runId] });
    await next.waitForEvent('run.parked');
    await next.post(runId, 'Review, look again');
    await next.waitForEvent('run.parked', 2);
    expect(next.calls('Review')).toBe(1);
  });

  it('a turn in flight at shutdown ends STOPPED, and the run stays open', async () => {
    const { h, ids } = await team();
    const runId = await parked(h);
    const held = deferred();
    h.scripts.set('Review', [{ hold: held.promise }]);
    await h.post(runId, 'Review, look again');
    await h.waitForState(ids.review, 'RUNNING', 2);

    await h.service.shutdown();

    const [turn] = (await h.nodeRunsOf(runId, ids.review)).slice(-1);
    expect(turn?.status).toBe('STOPPED');
    expect((await h.runRow(runId)).status).toBe('RUNNING');
    expect(h.payloads('run.completed')).toHaveLength(0);
  });

  it('a board run is still halted `shutdown`', async () => {
    const { h, ids } = await team();
    const held = deferred();
    h.scripts.set('Writer', [{ hold: held.promise }]);
    const begun = await h.start();
    await h.waitForState(ids.writer, 'RUNNING');

    await h.service.shutdown();

    expect(await begun.done).toMatchObject({ status: 'HALTED', haltReason: 'shutdown' });
  });
});

describe('D309 delivery', () => {
  it('a node that is not busy gets a turn now', async () => {
    const { h, ids } = await team();
    const runId = await parked(h);
    const sent = await h.post(runId, 'Review, check the numbers');
    expect(sent.delivery).toEqual([{ nodeId: ids.review, state: 'PENDING' }]);
    await h.waitForEvent('run.parked', 2);
    expect(statesOf(h, sent.messageId, ids.review)).toEqual(['PENDING', 'DELIVERED', 'DONE']);
    expect(hasText(h.prompts('Review').slice(-1), 'check the numbers')).toBe(true);
  });

  it('a busy node gets the instruction on its next turn, not the one already running', async () => {
    const { h, ids } = await team();
    const release = deferred();
    h.scripts.set('Writer', [{ text: 'first', hold: release.promise }, { text: 'second' }]);
    const begun = await h.start({ domain: { stayOpen: true } });
    await h.waitForState(ids.writer, 'RUNNING');

    const sent = await h.post(begun.run.id, 'Writer, use British spelling');
    expect(statesOf(h, sent.messageId, ids.writer)).toEqual(['PENDING']);
    release.resolve();
    await h.waitForEvent('run.parked');

    const prompts = h.prompts('Writer');
    expect(prompts).toHaveLength(2);
    expect(hasText([prompts[0] ?? ''], 'British spelling')).toBe(false);
    expect(hasText([prompts[1] ?? ''], 'British spelling')).toBe(true);
    expect(statesOf(h, sent.messageId, ids.writer)).toEqual(['PENDING', 'DELIVERED', 'DONE']);
  });

  it('an interrupted turn keeps its partial output, is INTERRUPTED and never handed off', async () => {
    const { h, ids } = await team();
    h.scripts.set('Writer', [
      { partial: 'Half a dra', hold: new Promise<void>(() => undefined) },
      { text: 'A whole new angle.' },
    ]);
    const begun = await h.start({ domain: { stayOpen: true } });
    await h.waitForState(ids.writer, 'RUNNING');

    const sent = await h.post(begun.run.id, 'Writer, stop — new angle', {
      deliveryMode: 'interrupt',
    });
    await h.waitForEvent('run.parked');

    expect(h.payloads('node.interrupted')).toEqual([
      expect.objectContaining({
        nodeId: ids.writer,
        messageId: sent.messageId,
        partialOutput: [{ type: 'text', text: 'Half a dra' }],
      }),
    ]);
    expect(h.framesOf(ids.writer)).toEqual([
      '1:READY',
      '1:RUNNING',
      '1:STOPPED',
      '2:READY',
      '2:RUNNING',
      '2:COMPLETED',
    ]);
    // Review read only the second turn.
    expect(h.calls('Review')).toBe(1);
    expect(hasText(h.prompts('Review'), 'Half a dra')).toBe(false);
    expect(hasText(h.prompts('Review'), 'A whole new angle.')).toBe(true);
    // The instruction rode the new turn.
    expect(hasText(h.prompts('Writer').slice(-1), 'new angle')).toBe(true);
    // The killed turn's usage is an estimate (D313).
    const [first] = await h.nodeRunsOf(begun.run.id, ids.writer);
    expect(first).toMatchObject({
      status: 'STOPPED',
      output: [{ type: 'text', text: 'Half a dra' }],
    });
    expect(first?.usage.source).toBe('estimated');
  });

  it('run end drops pending instructions', async () => {
    const { h, ids } = await team();
    const release = deferred();
    h.scripts.set('Writer', [{ hold: release.promise, throws: httpError(401) }]);
    const begun = await h.start();
    await h.waitForState(ids.writer, 'RUNNING');

    // @all rides each node's next or first turn; neither comes: Writer fails, Review is blocked.
    const sent = await h.post(begun.run.id, '@all keep it short');
    release.resolve();
    const done = await begun.done;

    expect(done.status).toBe('HALTED');
    expect(statesOf(h, sent.messageId, ids.writer)).toEqual(['PENDING', 'DROPPED']);
    expect(statesOf(h, sent.messageId, ids.review)).toEqual(['PENDING', 'DROPPED']);
    const lastDrop = h.events.map((event) => event.type).lastIndexOf('instruction.state');
    expect(lastDrop).toBeLessThan(h.indexOf('run.completed'));
  });

  it('a fan-out to two nodes reaches both', async () => {
    const { h, ids } = await team();
    const runId = await parked(h);
    const sent = await h.post(runId, 'Writer and Review, check the facts');
    expect(sent.delivery.map((each) => each.nodeId).sort()).toEqual(
      [ids.writer, ids.review].sort(),
    );
    await h.waitFor(() => statesOf(h, sent.messageId, ids.review).includes('DONE'), 'review done');
    await h.waitFor(() => statesOf(h, sent.messageId, ids.writer).includes('DONE'), 'writer done');
    expect(hasText(h.prompts('Writer'), 'check the facts')).toBe(true);
    expect(hasText(h.prompts('Review'), 'check the facts')).toBe(true);
  });

  it('an instruction to a node that ended in CONTRACT_VIOLATION starts a fresh turn', async () => {
    const h = await createRunDriverHarness();
    const fixer = h.agentNode('Fixer', {}, { outputTypes: ['json'] });
    await h.seed([fixer], []);
    h.scripts.set('Fixer', [
      { text: 'not json' },
      { text: 'still not json' },
      { text: '{"ok":true}' },
    ]);
    const runId = await parked(h);

    const failed = h.framesOf(fixer.id);
    expect(failed.at(-1)).toBe('2:FAILED');
    expect(h.payloads<{ failureReason: string }>('node.error').at(-1)?.failureReason).toBe(
      'CONTRACT_VIOLATION',
    );

    await h.post(runId, 'Fixer, return valid JSON');
    await h.waitForEvent('run.parked', 2);
    expect(h.framesOf(fixer.id).slice(-3)).toEqual(['3:READY', '3:RUNNING', '3:COMPLETED']);
  });
});

describe('D324/D325 addressing and privacy', () => {
  it('an instruction to one node never appears in another node’s prompt, or the Brain’s', async () => {
    const { h } = await team();
    const runId = await parked(h);
    await h.post(runId, 'Writer, mention the 1969 landing');
    await h.waitForEvent('run.parked', 2);
    expect(hasText(h.prompts('Writer'), '1969 landing')).toBe(true);
    expect(hasText(h.prompts('Review'), '1969 landing')).toBe(false);
    expect(hasText(h.prompts('Director'), '1969 landing')).toBe(false);
  });

  it('an unaddressed message reaches the Brain only', async () => {
    const { h, ids } = await team();
    const runId = await parked(h);
    const sent = await h.post(runId, 'how is it going overall?');
    expect(sent.delivery).toEqual([{ nodeId: ids.brain, state: 'PENDING' }]);
    await h.waitForEvent('run.parked', 2);
    expect(hasText(h.prompts('Director').slice(-1), 'how is it going overall?')).toBe(true);
    expect(hasText(h.prompts('Writer'), 'how is it going')).toBe(false);
    expect(hasText(h.prompts('Review'), 'how is it going')).toBe(false);
    expect(h.payloads<HumanMessagePayload>('human.message').at(-1)).toMatchObject({
      addressing: 'unaddressed',
      mentions: [{ nodeId: ids.brain, handle: 'brain', via: 'unaddressed' }],
    });
  });

  it('exclude removes a matched recipient', async () => {
    const { h, ids } = await team();
    const runId = await parked(h);
    const sent = await h.post(runId, 'Writer and Review, check this', { exclude: [ids.review] });
    expect(sent.delivery).toEqual([{ nodeId: ids.writer, state: 'PENDING' }]);
    expect(h.payloads<HumanMessagePayload>('human.message').at(-1)?.mentions).toEqual([
      { nodeId: ids.writer, handle: 'writer', via: 'name' },
    ]);
  });

  it('an exclude entry that was not a match is a 400, and nothing is written', async () => {
    const { h, ids } = await team();
    const runId = await parked(h);
    const before = h.events.length;
    const error = await refusal(h.post(runId, 'Writer, check this', { exclude: [ids.review] }));
    expect(error.status).toBe(400);
    expect(error.details).toMatchObject({
      errors: [{ code: 'exclude_not_matched', nodeId: ids.review }],
    });
    expect(h.events.length).toBe(before);
  });

  it('an unknown handle is a 400 with the closest matches, and nothing is written', async () => {
    const { h } = await team();
    const runId = await parked(h);
    const before = h.events.length;
    const error = await refusal(h.post(runId, '@writr please'));
    expect(error.status).toBe(400);
    expect(error.details).toMatchObject({
      errors: [{ code: 'unknown_handle', handle: '@writr', suggestions: ['@writer'] }],
    });
    expect(h.events.length).toBe(before);
  });

  it('with no Brain designated, an unaddressed message is no_brain', async () => {
    const h = await createRunDriverHarness();
    await h.seed([h.agentNode('Writer')], []);
    const runId = await parked(h);
    const error = await refusal(h.post(runId, 'anyone there?'));
    expect(error.status).toBe(400);
    expect(error.details).toMatchObject({
      errors: [{ code: 'no_brain', message: 'address a node by name or @handle' }],
    });
  });
});

describe('D326 @all', () => {
  it('mid-run on a chain: the running node gets it next turn, the pending one on its first, the finished one is skipped', async () => {
    const h = await createRunDriverHarness();
    const a = h.agentNode('Alpha');
    const b = h.agentNode('Beta', { retries: 1 });
    const c = h.agentNode('Gamma');
    await h.seed([a, b, c], [h.edge(a, b), h.edge(b, c)]);
    const release = deferred();
    // Beta's first attempt fails on a 503 after the hold: its retry is its next turn.
    h.scripts.set('Beta', [
      { hold: release.promise, throws: httpError(503) },
      { text: 'beta done' },
    ]);
    const begun = await h.start({ domain: { stayOpen: true } });
    await h.waitForState(b.id, 'RUNNING');

    const sent = await h.post(begun.run.id, '@all keep it short');
    expect(sent.delivery.map((each) => each.nodeId)).toEqual([b.id, c.id]);
    expect(h.payloads<HumanMessagePayload>('human.message').at(-1)).toMatchObject({
      addressing: 'all',
    });
    release.resolve();
    await h.waitForEvent('run.parked');

    expect(h.calls('Alpha')).toBe(1);
    expect(hasText(h.prompts('Alpha'), 'keep it short')).toBe(false);
    expect(hasText([h.prompts('Beta')[0] ?? ''], 'keep it short')).toBe(false);
    expect(hasText([h.prompts('Beta')[1] ?? ''], 'keep it short')).toBe(true);
    expect(hasText(h.prompts('Gamma'), 'keep it short')).toBe(true);
    expect(statesOf(h, sent.messageId, c.id)).toEqual(['PENDING', 'DELIVERED', 'DONE']);
  }, 15_000);

  it('when every node has finished it is 400 all_finished, and nothing is written', async () => {
    const { h } = await team();
    const runId = await parked(h);
    const before = h.events.length;
    const error = await refusal(h.post(runId, '@all one more pass'));
    expect(error.status).toBe(400);
    expect(error.details).toMatchObject({
      errors: [
        { code: 'all_finished', message: 'all nodes are done — name the ones you want to redo' },
      ],
    });
    expect(h.events.length).toBe(before);
  });

  it('with interrupt it is a 400, and nothing is written', async () => {
    const { h, ids } = await team();
    const release = deferred();
    h.scripts.set('Writer', [{ hold: release.promise, text: 'x' }]);
    const begun = await h.start({ domain: { stayOpen: true } });
    await h.waitForState(ids.writer, 'RUNNING');
    const before = h.events.length;
    const error = await refusal(h.post(begun.run.id, '@all stop', { deliveryMode: 'interrupt' }));
    expect(error.status).toBe(400);
    expect(error.details).toMatchObject({ errors: [{ code: 'all_queue_only' }] });
    expect(h.events.length).toBe(before);
    release.resolve();
  });
});

describe('D312 the goal', () => {
  it('is recorded as the run config and the first message, and every node reads it', async () => {
    const { h } = await team();
    const begun = await h.start({ goal: 'Write a tagline for ACE', domain: { stayOpen: true } });
    await h.waitForEvent('run.parked');
    expect(h.payloads('run.config')).toEqual([
      {
        runId: begun.run.id,
        config: { routing: 'supervised', loopGuardLimit: 3, tokenBudget: null, stayOpen: true },
      },
    ]);
    expect(h.payloads<HumanMessagePayload>('human.message')[0]).toMatchObject({
      text: 'Write a tagline for ACE',
      addressing: 'goal',
      mentions: [],
    });
    for (const name of ['Writer', 'Review', 'Director']) {
      expect(hasText(h.prompts(name), '## Team goal\nWrite a tagline for ACE')).toBe(true);
    }
  });
});
