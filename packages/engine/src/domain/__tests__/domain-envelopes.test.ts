import type {
  EdgeTransferPayload,
  EnvelopeRoutedPayload,
  EnvelopeSentPayload,
  NodeErrorPayload,
  NodeStatePayload,
  RunBlockedPayload,
} from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { HttpError } from '../../gateway/errors.js';
import {
  createRunDriverHarness,
  type RunDriverHarness,
} from '../../__tests__/run-driver-harness.js';
import { routeApp, send } from '../../__tests__/route-app.js';
import { domainContextFor } from '../context.js';
import { projectChat } from '../project-chat.js';
import { createDomainRoutes } from '../routes.js';

/*
 * Domain Gate 3 (D304, D305, D310): agents address each other only through envelope blocks, every
 * envelope passes through the Brain's router, and the loop guard stops two nodes going back and
 * forth for ever. All on the scripted provider.
 */

const block = (body: Record<string, unknown>): string =>
  `\`\`\`ace-envelope\n${JSON.stringify(body)}\n\`\`\``;
/** The id of the QUERY a prompt hands this node, as `## Team messages` quotes it. */
const queryIn = (prompt: string): string => /\[QUERY (\w+)\]/u.exec(prompt)?.[1] ?? 'none';

/** Writer → Review: the chain every scenario below runs on. */
async function chain(extra: { brain?: boolean } = {}) {
  const h = await createRunDriverHarness();
  const writer = h.agentNode('Writer');
  const review = h.agentNode('Review');
  const nodes = [writer, review];
  if (extra.brain === true) nodes.push(h.agentNode('Director', {}, { brain: true }));
  await h.seed(nodes, [h.edge(writer, review)]);
  return { h, writer, review, nodes, brain: nodes[2] };
}

const sentOf = (h: RunDriverHarness) => h.payloads<EnvelopeSentPayload>('envelope.sent');
const routedOf = (h: RunDriverHarness) => h.payloads<EnvelopeRoutedPayload>('envelope.routed');
const runningOf = (h: RunDriverHarness, nodeId: string) =>
  h
    .payloads<NodeStatePayload>('node.state')
    .filter((state) => state.nodeId === nodeId && state.status === 'RUNNING');

async function refusal(promise: Promise<unknown>): Promise<HttpError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('D310 envelopes between agents', () => {
  it('a reviewer FLAG reaches the writer, and the revised HANDOFF completes the run', async () => {
    const { h, writer, review } = await chain();
    h.scripts.set('Writer', [{ text: 'Draft one.' }, { text: 'Draft two, tighter.' }]);
    h.scripts.set('Review', [
      {
        text: `The opening drags.\n\n${block({ kind: 'FLAG', to: ['@writer'], summary: 'The hook is weak.' })}`,
      },
      { text: 'Approved.' },
    ]);

    const done = await (await h.start()).done;
    expect(done.status).toBe('COMPLETE');

    const sent = sentOf(h);
    expect(
      sent.map((each) => [each.kind, each.fromNodeId, each.toNodeIds, each.textSource]),
    ).toEqual([
      ['HANDOFF', writer.id, [review.id], 'auto'],
      ['FLAG', review.id, [writer.id], 'summary'],
      ['HANDOFF', writer.id, [review.id], 'auto'],
    ]);
    // Every envelope went through the Brain's router, which forwards in supervised mode.
    expect(routedOf(h).map((each) => [each.envelopeId, each.decision, each.by])).toEqual(
      sent.map((each) => [each.envelopeId, 'FORWARDED', 'brain']),
    );

    const flag = sent[1]!;
    expect(runningOf(h, writer.id).map((state) => state.trigger)).toEqual([
      undefined,
      { kind: 'envelope', envelopeIds: [flag.envelopeId] },
    ]);
    const revising = h.prompts('Writer')[1] ?? '';
    expect(revising).toContain(`[FLAG ${flag.envelopeId}] from @review: The hook is weak.`);
    expect(revising).toContain('> The opening drags.');

    // The flagging turn handed nothing on; the revised draft travelled as the second HANDOFF.
    expect(h.payloads<EdgeTransferPayload>('edge.transfer').map((each) => each.envelopeId)).toEqual(
      [sent[0]!.envelopeId, sent[2]!.envelopeId],
    );
    expect(h.prompts('Review')[1]).toContain('Draft two, tighter.');
    expect(h.calls('Writer')).toBe(2);
    expect(h.calls('Review')).toBe(2);
  });

  it('a QUERY gets an ANSWER linked by inReplyTo while the asker waits', async () => {
    const { h, writer, review } = await chain();
    h.scripts.set('Writer', [
      {
        text: `I need one fact.\n\n${block({ kind: 'QUERY', to: ['@review'], summary: 'Which year did ACE launch?' })}`,
      },
      { text: 'Draft citing 2026.' },
    ]);
    h.scripts.set('Review', [
      {
        reply: (prompt) =>
          block({ kind: 'ANSWER', to: ['@writer'], summary: '2026.', inReplyTo: queryIn(prompt) }),
      },
      { text: 'Approved.' },
    ]);

    const done = await (await h.start()).done;
    expect(done.status).toBe('COMPLETE');

    const [query, answer, handoff] = sentOf(h);
    expect([query?.kind, answer?.kind, handoff?.kind]).toEqual(['QUERY', 'ANSWER', 'HANDOFF']);
    expect(answer?.inReplyTo).toBe(query?.envelopeId);
    expect(answer?.toNodeIds).toEqual([writer.id]);

    // The asker's node run stays WAITING until the answer comes, then its next turn reads it.
    expect(h.framesOf(writer.id)).toEqual([
      '1:READY',
      '1:RUNNING',
      '1:WAITING',
      '1:COMPLETED',
      '2:READY',
      '2:RUNNING',
      '2:COMPLETED',
    ]);
    expect(h.prompts('Writer')[1]).toContain(`[ANSWER ${answer?.envelopeId}] from @review: 2026.`);

    // The addressee answered at once, before it was dispatched, and handed nothing on.
    expect(runningOf(h, review.id)[0]?.trigger).toEqual({
      kind: 'envelope',
      envelopeIds: [query?.envelopeId],
    });
    expect(h.prompts('Review')[0]).not.toContain('Draft');
    expect(h.payloads<EdgeTransferPayload>('edge.transfer').map((each) => each.envelopeId)).toEqual(
      [handoff?.envelopeId],
    );
    expect(h.prompts('Review')[1]).toContain('Draft citing 2026.');
  });

  it('an addressee that cannot answer sends the asker a note, and the asker carries on', async () => {
    const { h, writer } = await chain();
    h.scripts.set('Writer', [
      { text: block({ kind: 'QUERY', to: ['@review'], summary: 'Which year?' }) },
      { text: 'Draft without the year.' },
    ]);
    // Neither attempt answers the QUERY: the turn and its one repair are CONTRACT_VIOLATION.
    h.scripts.set('Review', [
      { text: 'No idea.' },
      { text: 'Still no idea.' },
      { text: 'Approved.' },
    ]);

    const done = await (await h.start()).done;
    expect(done.status).toBe('COMPLETE');

    const query = sentOf(h)[0]!;
    const note = sentOf(h).find((each) => each.kind === 'ANSWER');
    expect(note).toMatchObject({
      toNodeIds: [writer.id],
      inReplyTo: query.envelopeId,
      textSource: 'auto',
    });
    expect(note?.summary).toMatch(/could not answer/u);
    expect(h.prompts('Writer')[1]).toContain('could not answer');
    expect(h.prompts('Review')[1]).toContain(
      `Your previous answer was rejected: This turn was handed QUERY ${query.envelopeId}`,
    );
  });

  it('a handle written in prose or code addresses nobody', async () => {
    const { h, writer } = await chain();
    h.scripts.set('Review', [{ text: 'Thanks @writer. Writer, keep it. `@writer` is fine.' }]);
    const done = await (await h.start()).done;
    expect(done.status).toBe('COMPLETE');
    expect(h.calls('Writer')).toBe(1);
    expect(sentOf(h).map((each) => [each.kind, each.fromNodeId])).toEqual([['HANDOFF', writer.id]]);
  });

  it('the Brain reads a digest of what was routed when an envelope gives it a turn', async () => {
    const { h } = await chain({ brain: true });
    h.scripts.set('Review', [
      { text: block({ kind: 'FLAG', to: ['@brain'], summary: 'Need your call on tone.' }) },
    ]);
    const done = await (await h.start()).done;
    expect(done.status).toBe('COMPLETE');
    const second = h.prompts('Director')[1] ?? '';
    expect(second).toContain('## Envelope digest');
    expect(second).toContain('HANDOFF @writer → @review');
    expect(second).toContain('[FLAG ');
    expect(h.prompts('Writer').join('\n')).not.toContain('## Envelope digest');
  });
});

describe('D310 contract violations', () => {
  it('a malformed envelope is a CONTRACT_VIOLATION, repaired once with the reason', async () => {
    const { h, review } = await chain();
    h.scripts.set('Review', [
      { text: 'Looks fine.\n\n```ace-envelope\n{"kind": "FLAG", "to": [\n```' },
      { text: 'Approved.' },
    ]);
    const done = await (await h.start()).done;
    expect(done.status).toBe('COMPLETE');
    expect(h.framesOf(review.id)).toEqual([
      '1:READY',
      '1:RUNNING',
      '1:FAILED',
      '2:READY',
      '2:RUNNING',
      '2:COMPLETED',
    ]);
    const error = h
      .payloads<NodeErrorPayload>('node.error')
      .find((each) => each.nodeId === review.id);
    expect(error?.failureReason).toBe('CONTRACT_VIOLATION');
    expect(error?.error.message).toMatch(/^Envelope block 1 is not valid JSON/u);
    expect(h.prompts('Review')[1]).toContain('Your previous answer was rejected: Envelope block 1');
    expect(sentOf(h).some((each) => each.fromNodeId === review.id)).toBe(false);
  });

  it('a HANDOFF to a node it does not feed fails the node when the repair repeats it', async () => {
    const { h, review } = await chain();
    h.scripts.set('Review', [
      { text: block({ kind: 'HANDOFF', to: ['@writer'], summary: 'Back to you.' }) },
    ]);
    const done = await (await h.start()).done;
    expect(done.status).toBe('HALTED');
    expect(h.framesOf(review.id).at(-1)).toBe('2:FAILED');
    const errors = h
      .payloads<NodeErrorPayload>('node.error')
      .filter((each) => each.nodeId === review.id);
    expect(errors.map((each) => each.failureReason)).toEqual([
      'CONTRACT_VIOLATION',
      'CONTRACT_VIOLATION',
    ]);
    expect(errors[0]?.error.message).toContain('does not feed @writer');
  });
});

describe('D305 D310 the loop guard', () => {
  it('ping-pong past the limit holds the envelope and blocks the run; resume carries on', async () => {
    const { h, writer, review } = await chain();
    const flag = { text: block({ kind: 'FLAG', to: ['@writer'], summary: 'Again.' }) };
    h.scripts.set('Writer', [
      { text: 'Draft 1.' },
      { text: 'Draft 2.' },
      { text: 'Draft 3.' },
      { text: 'Draft 4.' },
    ]);
    h.scripts.set('Review', [flag, flag, flag, { text: 'Approved.' }]);

    const begun = await h.start({ domain: { loopGuardLimit: 2 } });
    const runId = begun.run.id;
    await h.waitForEvent('run.blocked');

    expect(h.payloads<RunBlockedPayload>('run.blocked')).toEqual([
      expect.objectContaining({
        runId,
        reason: 'LOOP_GUARD',
        nodeIds: [writer.id, review.id].sort(),
      }),
    ]);
    const held = routedOf(h).at(-1);
    expect(held).toMatchObject({ decision: 'HELD', by: 'brain', reason: 'LOOP_GUARD' });
    const row = await h.runRow(runId);
    expect(row.status).toBe('BLOCKED');
    expect(row.blockedReason).toBe('LOOP_GUARD');
    expect(row.allowedActions).toEqual(expect.arrayContaining(['resume', 'stop']));

    // Blocked: nothing more is called.
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect([h.calls('Writer'), h.calls('Review')]).toEqual([3, 3]);

    await h.controls.resume(runId);
    const done = await begun.done;
    expect(done.status).toBe('COMPLETE');
    // Resume released what the guard held — the human's decision — and reset the pair's count.
    expect(routedOf(h).filter((each) => each.envelopeId === held?.envelopeId)).toEqual([
      expect.objectContaining({ decision: 'HELD', by: 'brain' }),
      expect.objectContaining({ decision: 'FORWARDED', by: 'human' }),
    ]);
    expect([h.calls('Writer'), h.calls('Review')]).toEqual([4, 4]);
  });
});

/** The id of the `count`-th envelope held, once it has been. */
async function heldAt(h: RunDriverHarness, count: number): Promise<string> {
  const held = () => routedOf(h).filter((each) => each.decision === 'HELD');
  await h.waitFor(() => held().length >= count, `envelope ${count} held`);
  return held()[count - 1]!.envelopeId;
}

describe('D310 manual routing', () => {
  it('an edited envelope is forwarded as edited, and both versions are logged', async () => {
    const { h, nodes } = await chain();
    h.scripts.set('Writer', [{ text: 'Draft one.' }, { text: 'Draft two.' }]);
    h.scripts.set('Review', [
      { text: `Too wordy.\n\n${block({ kind: 'FLAG', to: ['@writer'], summary: 'Too long.' })}` },
      { text: 'Approved.' },
    ]);
    const begun = await h.start({ domain: { routing: 'manual' } });
    const runId = begun.run.id;

    const first = await heldAt(h, 1);
    expect(h.calls('Review')).toBe(0);
    expect(await h.route(runId, first, { decision: 'approve' })).toEqual({
      envelopeId: first,
      routing: 'FORWARDED',
    });

    const flag = await heldAt(h, 2);
    expect(
      await h.route(runId, flag, {
        decision: 'edit',
        edit: { summary: 'Too long; cut it to 8 words.' },
      }),
    ).toEqual({ envelopeId: flag, routing: 'EDITED' });

    await h.route(runId, await heldAt(h, 3), { decision: 'approve' });
    expect((await begun.done).status).toBe('COMPLETE');

    expect(sentOf(h).find((each) => each.envelopeId === flag)?.summary).toBe('Too long.');
    expect(
      routedOf(h).find((each) => each.envelopeId === flag && each.decision === 'EDITED'),
    ).toMatchObject({
      by: 'human',
      edit: { summary: 'Too long; cut it to 8 words.' },
    });
    const revising = h.prompts('Writer')[1] ?? '';
    expect(revising).toContain(`[FLAG ${flag}] from @review: Too long; cut it to 8 words.`);
    expect(revising).not.toContain('from @review: Too long.\n');

    const message = projectChat(
      h.events.filter((event) => event.runId === runId),
      domainContextFor(runId, nodes),
    ).find((each) => each.id === `env:${flag}`);
    expect(message?.envelope?.original?.summary).toBe('Too long.');
  });

  it('a rejected envelope is dropped, and its sender gets a turn with the reason', async () => {
    const { h } = await chain();
    h.scripts.set('Review', [
      { text: block({ kind: 'FLAG', to: ['@writer'], summary: 'Rewrite it all.' }) },
      { text: 'Fine, approved.' },
    ]);
    const begun = await h.start({ domain: { routing: 'manual' } });
    const runId = begun.run.id;
    await h.route(runId, await heldAt(h, 1), { decision: 'approve' });
    const flag = await heldAt(h, 2);
    expect(
      await h.route(runId, flag, { decision: 'reject', reason: 'The draft is fine.' }),
    ).toEqual({
      envelopeId: flag,
      routing: 'REJECTED',
    });
    expect((await begun.done).status).toBe('COMPLETE');
    expect(h.calls('Writer')).toBe(1);
    expect(h.calls('Review')).toBe(2);
    expect(h.prompts('Review')[1]).toContain('The draft is fine.');
  });

  it('what is held, and what is forwarded but not yet taken, survive an engine restart', async () => {
    const { h, writer, review } = await chain();
    h.scripts.set('Review', [
      {
        text: `Check this.\n\n${block({ kind: 'FLAG', to: ['@writer'], summary: 'Cite a source.' })}`,
      },
    ]);
    const begun = await h.start({ domain: { routing: 'manual', stayOpen: true } });
    const runId = begun.run.id;
    await h.route(runId, await heldAt(h, 1), { decision: 'approve' });
    const flag = await heldAt(h, 2);
    await h.waitForEvent('run.parked', 2);

    // A second process over the same store: the FLAG is still held there, and approving it there
    // gives the writer its turn with the FLAG in its prompt.
    const next = await createRunDriverHarness({ repository: h.repository });
    next.scripts.set('Writer', [{ text: 'Draft with a source.' }]);
    expect((await next.recover()).reopened).toEqual([runId]);
    await next.waitForEvent('run.parked');
    expect(next.totalCalls()).toBe(0);

    expect(await next.route(runId, flag, { decision: 'approve' })).toEqual({
      envelopeId: flag,
      routing: 'FORWARDED',
    });
    await next.waitFor(() => next.calls('Writer') === 1, 'the writer takes the FLAG');
    expect(next.prompts('Writer')[0]).toContain(`[FLAG ${flag}] from @review: Cite a source.`);
    expect(next.prompts('Writer')[0]).toContain('> Check this.');
    // Its revised HANDOFF is held again, for the human, in the new process.
    await next.waitFor(
      () => routedOf(next).filter((each) => each.decision === 'HELD').length === 1,
      'the revised handoff held',
    );
    expect(sentOf(next).at(-1)).toMatchObject({
      kind: 'HANDOFF',
      fromNodeId: writer.id,
      toNodeIds: [review.id],
    });
    await next.end(runId);
  });

  it('refuses a decision on an envelope that is not held, or an edit to nobody', async () => {
    const { h } = await chain();
    const begun = await h.start({ domain: { routing: 'manual' } });
    const runId = begun.run.id;
    const first = await heldAt(h, 1);

    expect(
      (await refusal(h.route(runId, '01JBXQ8Z9KQ4R7N2VWXYZ0E999', { decision: 'approve' }))).status,
    ).toBe(404);
    const before = h.events.length;
    const unknown = await refusal(
      h.route(runId, first, { decision: 'edit', edit: { to: ['@nobody'] } }),
    );
    expect(unknown.status).toBe(400);
    expect(h.events.length).toBe(before);

    await h.route(runId, first, { decision: 'approve' });
    expect((await refusal(h.route(runId, first, { decision: 'approve' }))).status).toBe(409);
    expect((await begun.done).status).toBe('COMPLETE');
  });
});

describe('D310 POST /runs/:runId/envelopes/:id/route', () => {
  it('200 with the routing; 400 a bad decision; 404 no such envelope; 409 once routed', async () => {
    const { h } = await chain();
    const begun = await h.start({ domain: { routing: 'manual' } });
    const runId = begun.run.id;
    const first = await heldAt(h, 1);
    const app = routeApp(createDomainRoutes(() => h.domain));
    const path = (envelopeId: string) => `/runs/${runId}/envelopes/${envelopeId}/route`;

    expect((await send(app, 'POST', path(first), { decision: 'forward' })).status).toBe(400);
    const missing = await send(app, 'POST', path('01JBXQ8Z9KQ4R7N2VWXYZ0E999'), {
      decision: 'approve',
    });
    expect(missing.status).toBe(404);

    const ok = await send(app, 'POST', path(first), { decision: 'approve' });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ envelopeId: first, routing: 'FORWARDED' });
    const again = await send(app, 'POST', path(first), { decision: 'approve' });
    expect(again.status).toBe(409);
    expect((await begun.done).status).toBe('COMPLETE');
  });
});
