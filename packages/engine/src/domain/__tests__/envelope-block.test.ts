import { rosterFor } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import {
  extractEnvelopeBlocks,
  judgeEnvelopeBlocks,
  type JudgeContext,
} from '../envelope-block.js';
import { countLoop, pairKey, routeEnvelope } from '../brain.js';
import { agent, envOf, nodeId } from './run-log.js';

/* D310: envelope blocks are read out of an agent's output, judged, and routed through the Brain. */

const fence = (body: string): string => `\`\`\`ace-envelope\n${body}\n\`\`\``;

describe('D310 extractEnvelopeBlocks', () => {
  it('takes every fenced block out and leaves the rest of the answer', () => {
    const text = `Here is my review.\n\n${fence('{"kind":"FLAG","to":["@writer"],"summary":"Too long."}')}\n\nThanks.`;
    expect(extractEnvelopeBlocks(text)).toEqual({
      text: 'Here is my review.\n\nThanks.',
      blocks: ['{"kind":"FLAG","to":["@writer"],"summary":"Too long."}'],
    });
  });

  it('an answer with no block is untouched', () => {
    expect(extractEnvelopeBlocks('Just the draft.')).toEqual({
      text: 'Just the draft.',
      blocks: [],
    });
  });

  it('other fences stay where they are', () => {
    const text = 'Code:\n```ts\nconst a = 1;\n```';
    expect(extractEnvelopeBlocks(text)).toEqual({ text, blocks: [] });
  });
});

describe('D310 judgeEnvelopeBlocks', () => {
  const roster = rosterFor([
    agent(1, 'Writer'),
    agent(2, 'Review'),
    agent(3, 'Research'),
    agent(4, 'Director', { brain: true }),
  ]);
  const ctx = (extra: Partial<JudgeContext> = {}): JudgeContext => ({
    roster,
    fromNodeId: nodeId(2),
    successors: new Set([nodeId(3)]),
    openQueries: new Map(),
    mustAnswer: [],
    ...extra,
  });

  it('resolves handles, with or without @, and keeps the summary', () => {
    expect(
      judgeEnvelopeBlocks(
        ['{"kind":"FLAG","to":["writer","@brain"],"summary":"The hook is weak."}'],
        ctx(),
      ),
    ).toEqual({
      ok: true,
      envelopes: [
        { kind: 'FLAG', toNodeIds: [nodeId(1), nodeId(4)], summary: 'The hook is weak.' },
      ],
    });
  });

  it('a block that is not JSON, or misses its summary, is a violation that says why', () => {
    expect(judgeEnvelopeBlocks(['{"kind": "FLAG", "to": ['], ctx())).toMatchObject({
      ok: false,
      reason: expect.stringContaining('not valid JSON'),
    });
    expect(judgeEnvelopeBlocks(['{"kind":"FLAG","to":["@writer"]}'], ctx())).toMatchObject({
      ok: false,
      reason: expect.stringContaining('summary'),
    });
  });

  it('an unknown handle, @all, or the sender itself is a violation', () => {
    expect(
      judgeEnvelopeBlocks(['{"kind":"QUERY","to":["@writr"],"summary":"?"}'], ctx()),
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining('@writer'),
    });
    expect(judgeEnvelopeBlocks(['{"kind":"QUERY","to":["@all"],"summary":"?"}'], ctx()).ok).toBe(
      false,
    );
    expect(judgeEnvelopeBlocks(['{"kind":"FLAG","to":["@review"],"summary":"me"}'], ctx()).ok).toBe(
      false,
    );
  });

  it('a HANDOFF may only go to a node this one feeds', () => {
    expect(
      judgeEnvelopeBlocks(['{"kind":"HANDOFF","to":["@research"],"summary":"Done."}'], ctx()).ok,
    ).toBe(true);
    expect(
      judgeEnvelopeBlocks(['{"kind":"HANDOFF","to":["@writer"],"summary":"Done."}'], ctx()),
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining('@research'),
    });
  });

  it('an ANSWER needs an open QUERY to this node, and goes back to its asker', () => {
    const openQueries = new Map([[envOf(1), { from: nodeId(1), to: [nodeId(2)] }]]);
    const answer = (inReplyTo: string, to = '@writer') =>
      `{"kind":"ANSWER","to":["${to}"],"summary":"1969.","inReplyTo":"${inReplyTo}"}`;
    expect(judgeEnvelopeBlocks([answer(envOf(1))], ctx({ openQueries })).ok).toBe(true);
    expect(judgeEnvelopeBlocks([answer(envOf(2))], ctx({ openQueries }))).toMatchObject({
      ok: false,
      reason: expect.stringContaining('no QUERY'),
    });
    expect(
      judgeEnvelopeBlocks(
        ['{"kind":"ANSWER","to":["@writer"],"summary":"x"}'],
        ctx({ openQueries }),
      ).ok,
    ).toBe(false);
    expect(judgeEnvelopeBlocks([answer(envOf(1), '@research')], ctx({ openQueries })).ok).toBe(
      false,
    );
  });

  it('a turn that asks or flags does not also hand off', () => {
    const handoff = '{"kind":"HANDOFF","to":["@research"],"summary":"Done."}';
    expect(
      judgeEnvelopeBlocks(
        [handoff, '{"kind":"QUERY","to":["@writer"],"summary":"Which year?"}'],
        ctx(),
      ),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('HANDOFF') });
    expect(
      judgeEnvelopeBlocks(
        [handoff, '{"kind":"FLAG","to":["@writer"],"summary":"Weak hook."}'],
        ctx(),
      ).ok,
    ).toBe(false);
  });

  it('a turn a QUERY started must ANSWER it', () => {
    const openQueries = new Map([[envOf(1), { from: nodeId(1), to: [nodeId(2)] }]]);
    expect(judgeEnvelopeBlocks([], ctx({ openQueries, mustAnswer: [envOf(1)] }))).toMatchObject({
      ok: false,
      reason: expect.stringContaining(envOf(1)),
    });
  });
});

describe('D310 the Brain routes, and the loop guard counts', () => {
  const a = nodeId(1);
  const b = nodeId(2);

  it('supervised forwards; manual holds everything', () => {
    expect(
      routeEnvelope({
        mode: 'supervised',
        kind: 'HANDOFF',
        from: a,
        to: [b],
        counts: new Map(),
        limit: 3,
      }),
    ).toEqual({
      decision: 'FORWARDED',
    });
    expect(
      routeEnvelope({
        mode: 'manual',
        kind: 'HANDOFF',
        from: a,
        to: [b],
        counts: new Map(),
        limit: 3,
      }),
    ).toEqual({
      decision: 'HELD',
      reason: 'manual routing',
    });
  });

  it('counts QUERY and FLAG per unordered pair, and holds the one over the limit', () => {
    const counts = new Map<string, number>();
    for (let sent = 1; sent <= 3; sent += 1) {
      const from = sent % 2 === 0 ? b : a;
      const to = from === a ? b : a;
      countLoop(counts, 'FLAG', from, [to]);
      expect(
        routeEnvelope({ mode: 'supervised', kind: 'FLAG', from, to: [to], counts, limit: 3 })
          .decision,
      ).toBe('FORWARDED');
    }
    expect(counts.get(pairKey(a, b))).toBe(3);
    countLoop(counts, 'QUERY', a, [b]);
    expect(
      routeEnvelope({ mode: 'supervised', kind: 'QUERY', from: a, to: [b], counts, limit: 3 }),
    ).toEqual({
      decision: 'HELD',
      reason: 'LOOP_GUARD',
      loopGuard: { nodeIds: [a, b].sort(), count: 4 },
    });
  });

  it('HANDOFF and ANSWER do not count', () => {
    const counts = new Map<string, number>();
    countLoop(counts, 'HANDOFF', a, [b]);
    countLoop(counts, 'ANSWER', a, [b]);
    expect(counts.size).toBe(0);
  });
});
