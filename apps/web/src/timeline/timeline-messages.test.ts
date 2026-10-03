import type { Message } from '@ace/contracts';

import {
  applyMessageFilter,
  filterFromParams,
  isEmptyFilter,
  loadAllMessages,
  nodeOptions,
  orderMessages,
  paramsFromFilter,
  resolveMessageMeta,
  runOptions,
} from './timeline-messages';

const WF = 'wf-1';
const RUN_A = 'run-a';
const RUN_B = 'run-b';
const NODE_A = 'node-a';
const NODE_B = 'node-b';

const message = (overrides: Partial<Message> & Pick<Message, 'id' | 'type'>): Message => ({
  workflowId: WF,
  content: [{ type: 'text', text: overrides.id }],
  at: '2026-09-29T10:00:00.000Z',
  ...overrides,
});

describe('orderMessages', () => {
  it('sorts by timestamp and collapses a duplicate id to the first seen', () => {
    const first = message({ id: 'm1', type: 'user', at: '2026-09-29T10:00:02.000Z' });
    const second = message({ id: 'm2', type: 'agent', at: '2026-09-29T10:00:01.000Z' });
    const duplicate = message({ id: 'm1', type: 'user', at: '2026-09-29T10:00:02.000Z' });

    const ordered = orderMessages([first, second, duplicate]);

    expect(ordered.map((m) => m.id)).toEqual(['m2', 'm1']);
  });

  it('keeps input order for equal timestamps (persisted page before the live tail)', () => {
    const a = message({ id: 'a', type: 'event' });
    const b = message({ id: 'b', type: 'event' });
    expect(orderMessages([a, b]).map((m) => m.id)).toEqual(['a', 'b']);
  });
});

describe('applyMessageFilter (FR-CHAT-002 — combinable)', () => {
  const messages: Message[] = [
    message({ id: 'm1', type: 'user', runId: RUN_A }),
    message({ id: 'm2', type: 'agent', runId: RUN_A, nodeId: NODE_A }),
    message({ id: 'm3', type: 'error', runId: RUN_A, nodeId: NODE_A }),
    message({ id: 'm4', type: 'error', runId: RUN_B, nodeId: NODE_B }),
  ];

  it('filters by node and type together, intersecting', () => {
    const result = applyMessageFilter(messages, { nodeId: NODE_A, type: 'error' });
    expect(result.map((m) => m.id)).toEqual(['m3']);
  });

  it('filters by run alone', () => {
    expect(applyMessageFilter(messages, { runId: RUN_B }).map((m) => m.id)).toEqual(['m4']);
  });

  it('an empty filter passes everything', () => {
    expect(applyMessageFilter(messages, {})).toHaveLength(4);
    expect(isEmptyFilter({})).toBe(true);
    expect(isEmptyFilter({ type: 'user' })).toBe(false);
  });
});

describe('runOptions / nodeOptions', () => {
  const messages: Message[] = [
    message({ id: 'm1', type: 'user', runId: RUN_A }),
    message({ id: 'm2', type: 'agent', runId: RUN_A, nodeId: NODE_A }),
    message({ id: 'm3', type: 'agent', runId: RUN_B, nodeId: NODE_B }),
    message({ id: 'm4', type: 'system' }),
  ];

  it('lists the run and node ids present, in first-seen order, without repeats', () => {
    expect(runOptions(messages)).toEqual([RUN_A, RUN_B]);
    expect(nodeOptions(messages)).toEqual([NODE_A, NODE_B]);
  });
});

describe('resolveMessageMeta', () => {
  const nodes = [
    { id: NODE_A, name: 'Writer', providerId: 'prov-1' },
    { id: NODE_B, name: 'Reviewer' },
  ];
  const providers = [{ id: 'prov-1', type: 'anthropic' as const }];

  it('resolves node name and provider accent for an agent message', () => {
    const meta = resolveMessageMeta(
      message({ id: 'm', type: 'agent', nodeId: NODE_A }),
      nodes,
      providers,
    );
    expect(meta).toEqual({ nodeName: 'Writer', provider: 'anthropic' });
  });

  it('resolves only the name when the node names no provider', () => {
    const meta = resolveMessageMeta(
      message({ id: 'm', type: 'output', nodeId: NODE_B }),
      nodes,
      providers,
    );
    expect(meta).toEqual({ nodeName: 'Reviewer' });
  });

  it('returns nothing for a message with no node', () => {
    expect(resolveMessageMeta(message({ id: 'm', type: 'user' }), nodes, providers)).toEqual({});
  });
});

describe('filter <-> URL query (FR-CHAT-002 reflected in the URL)', () => {
  it('round-trips a full filter through the query string', () => {
    const filter = { runId: RUN_A, nodeId: NODE_A, type: 'error' as const };
    const params = paramsFromFilter(filter);
    expect(params.get('run')).toBe(RUN_A);
    expect(params.get('node')).toBe(NODE_A);
    expect(params.get('type')).toBe('error');
    expect(filterFromParams(params)).toEqual(filter);
  });

  it('drops unset fields and ignores an unknown type', () => {
    expect(paramsFromFilter({}).toString()).toBe('');
    expect(filterFromParams(new URLSearchParams('type=bogus'))).toEqual({});
  });
});

describe('D-071 loadAllMessages follows nextCursor to the end (FR-CHAT-001, R4 §5 item 4)', () => {
  const many = Array.from({ length: 250 }, (_, i) =>
    message({ id: `m-${String(i).padStart(4, '0')}`, type: 'agent' }),
  );
  const pages = (pageSize: number) => async (cursor?: string) => {
    const from = cursor === undefined ? 0 : Number(cursor);
    const items = many.slice(from, from + pageSize);
    const next = from + pageSize;
    return next < many.length ? { items, nextCursor: String(next) } : { items };
  };

  it('loads every page, so the newest of 250 messages is there after a reload', async () => {
    const all = await loadAllMessages(pages(100));
    expect(all).toHaveLength(250);
    expect(all.at(-1)?.id).toBe('m-0249');
  });

  it('asks for each page with the cursor the previous one returned', async () => {
    const cursors: (string | undefined)[] = [];
    const fetchPage = pages(100);
    await loadAllMessages(async (cursor) => {
      cursors.push(cursor);
      return fetchPage(cursor);
    });
    expect(cursors).toEqual([undefined, '100', '200']);
  });

  it('stops on a cursor it has already followed instead of looping forever', async () => {
    let calls = 0;
    const all = await loadAllMessages(async () => {
      calls += 1;
      return { items: [many[calls]!], nextCursor: 'same' };
    });
    expect(calls).toBe(2);
    expect(all).toHaveLength(2);
  });
});
