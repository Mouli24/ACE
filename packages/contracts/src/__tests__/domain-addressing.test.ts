import { describe, expect, it } from 'vitest';

import {
  parseAddressing,
  resolveAddressing,
  rosterFor,
  slugHandle,
  type RosterEntry,
} from '../domain.js';
import { AgentConfigSchema, type Node } from '../graph.js';
import type { NodeState } from '../enums.js';

/*
 * Domain addressing (D308, D324, D326): one pure parser, shared by the engine and the composer,
 * reads plain names, @handles and @all out of a human message and returns the recipients and the
 * spans it matched. These are the owner's cases, word for word where the prompt gave them.
 */

const WF = '01JBXQ8Z9KQ4R7N2VWXYZ0WKFW';

/** Ids in creation order: ULIDs sort by time, so `id(1)` was made before `id(2)`. */
const id = (n: number): string => `01JBXQ8Z9KQ4R7N2VWXYZ0N${String(n).padStart(3, '0')}`;

function agent(n: number, name: string, extra: { handle?: string; brain?: boolean } = {}): Node {
  return {
    id: id(n),
    workflowId: WF,
    kind: 'agent',
    name,
    position: { x: 0, y: 0 },
    inputs: [],
    outputs: [],
    ...(extra.handle === undefined ? {} : { handle: extra.handle }),
    config: AgentConfigSchema.parse({
      instructions: `Act as ${name}.`,
      inputTypes: ['text'],
      outputTypes: ['text'],
      ...(extra.brain === undefined ? {} : { brain: extra.brain }),
    }),
  };
}

function inputNode(n: number, name: string): Node {
  return {
    id: id(n),
    workflowId: WF,
    kind: 'input',
    name,
    position: { x: 0, y: 0 },
    inputs: [],
    outputs: [],
    config: { artifactIds: [], outputTypes: ['text'] },
  };
}

const roster = (...nodes: Node[]): RosterEntry[] => rosterFor(nodes);
const names = (r: readonly RosterEntry[], ids: readonly string[]): string[] =>
  ids.map((nodeId) => r.find((entry) => entry.nodeId === nodeId)?.name ?? nodeId);

describe('D308 roster and default handles', () => {
  it('slugs a name into a handle', () => {
    expect(slugHandle('Draft writer')).toBe('draft-writer');
    expect(slugHandle('  Risk  Analyst!! ')).toBe('risk-analyst');
    expect(slugHandle('3D Artist')).toBe('n-3d-artist');
    expect(slugHandle('???')).toBe('node');
    expect(slugHandle('x'.repeat(60))).toHaveLength(32);
  });

  it('defaults each handle to its name and numbers collisions in creation order', () => {
    const r = roster(agent(2, 'Review'), agent(1, 'Review'), agent(3, 'Writer'));
    expect(r.map((entry) => [entry.name, entry.handle])).toEqual([
      ['Review', 'review'],
      ['Review', 'review-2'],
      ['Writer', 'writer'],
    ]);
    expect(r[0]?.nodeId).toBe(id(1));
  });

  it('keeps an explicit handle, and a default never takes it', () => {
    const r = roster(agent(1, 'Writer'), agent(2, 'Editor', { handle: 'writer' }));
    expect(r.find((entry) => entry.name === 'Editor')?.handle).toBe('writer');
    expect(r.find((entry) => entry.name === 'Writer')?.handle).toBe('writer-2');
  });

  it('gives the Brain @brain, and no other node the reserved handles', () => {
    const r = roster(agent(1, 'Brain'), agent(2, 'Director', { brain: true }), agent(3, 'All'));
    expect(r.find((entry) => entry.brain)?.handle).toBe('brain');
    expect(r.find((entry) => entry.name === 'Brain')?.handle).toBe('brain-2');
    expect(r.find((entry) => entry.name === 'All')?.handle).toBe('all-2');
  });

  it('lists only agent and model nodes', () => {
    expect(roster(inputNode(1, 'Brief'), agent(2, 'Writer')).map((entry) => entry.name)).toEqual([
      'Writer',
    ]);
  });
});

describe('D324 addressing by plain name', () => {
  const team = roster(
    agent(1, 'Nova'),
    agent(2, 'Iris'),
    agent(3, 'Theo'),
    agent(4, 'Director', { brain: true }),
  );

  it('"Nova, tighten the hook" → Nova', () => {
    const parsed = parseAddressing('Nova, tighten the hook', team);
    expect(parsed.errors).toEqual([]);
    expect(names(team, parsed.recipients)).toEqual(['Nova']);
    expect(parsed.spans).toEqual([{ start: 0, end: 4, via: 'name', nodeId: id(1), text: 'Nova' }]);
  });

  it('"can iris and theo check this" → Iris and Theo', () => {
    const parsed = parseAddressing('can iris and theo check this', team);
    expect(parsed.errors).toEqual([]);
    expect(names(team, parsed.recipients)).toEqual(['Iris', 'Theo']);
  });

  it('a node named "Review" is matched by "please review this" (documented; the preview can remove it)', () => {
    const r = roster(agent(1, 'Review'));
    const parsed = parseAddressing('please review this', r);
    expect(names(r, parsed.recipients)).toEqual(['Review']);
    expect(parsed.spans[0]).toMatchObject({ start: 7, end: 13, via: 'name' });
  });

  it('"Risk Analyst, check" with nodes "Risk" and "Risk Analyst" → Risk Analyst only', () => {
    const r = roster(agent(1, 'Risk'), agent(2, 'Risk Analyst'));
    const parsed = parseAddressing('Risk Analyst, check', r);
    expect(parsed.errors).toEqual([]);
    expect(names(r, parsed.recipients)).toEqual(['Risk Analyst']);
  });

  it('a multi-word name matches only as the full phrase', () => {
    const r = roster(agent(1, 'Risk Analyst'));
    expect(parseAddressing('the risk is low, analyst', r).recipients).toEqual([]);
    expect(names(r, parseAddressing('risk   analyst, go', r).recipients)).toEqual(['Risk Analyst']);
  });

  it('matches whole words only, case-insensitively', () => {
    expect(parseAddressing('novak and supernova', team).recipients).toEqual([]);
    expect(names(team, parseAddressing('NOVA: go', team).recipients)).toEqual(['Nova']);
  });

  it('a name two nodes share is an error that lists both @handles', () => {
    const r = roster(agent(1, 'Writer'), agent(2, 'writer'));
    const parsed = parseAddressing('Writer, draft it', r);
    expect(parsed.recipients).toEqual([]);
    expect(parsed.errors).toEqual([
      expect.objectContaining({
        code: 'ambiguous_name',
        handles: ['@writer', '@writer-2'],
        span: { start: 0, end: 6 },
      }),
    ]);
  });

  it('"check all the claims" → no recipients', () => {
    const parsed = parseAddressing('check all the claims', team);
    expect(parsed).toMatchObject({ all: false, recipients: [], errors: [] });
  });

  it('a node named "All" is not matched by the word "all" (nor "Everyone" or "Brain" by theirs)', () => {
    const r = roster(agent(1, 'All'), agent(2, 'Everyone'), agent(3, 'Brain'));
    const parsed = parseAddressing('all of you, everyone, and the brain', r);
    expect(parsed).toMatchObject({ all: false, recipients: [], errors: [] });
    // Their @handles still work.
    expect(names(r, parseAddressing('@all-2 and @everyone', r).recipients)).toEqual([
      'All',
      'Everyone',
    ]);
  });
});

describe('D308 @handles', () => {
  const team = roster(
    agent(1, 'Nova'),
    agent(2, 'Draft writer'),
    agent(3, 'Director', { brain: true }),
  );

  it('addresses a node by its handle, ignoring trailing punctuation', () => {
    const parsed = parseAddressing('@draft-writer, cut it.', team);
    expect(names(team, parsed.recipients)).toEqual(['Draft writer']);
    expect(parsed.spans[0]).toMatchObject({ start: 0, end: 13, via: 'handle' });
  });

  it('a name and a handle for the same node give one recipient', () => {
    expect(parseAddressing('Nova (@nova) go', team).recipients).toEqual([id(1)]);
  });

  it('@brain is the Brain', () => {
    expect(names(team, parseAddressing('@brain plan it', team).recipients)).toEqual(['Director']);
  });

  it('@brain with no Brain designated is no_brain', () => {
    const r = roster(agent(1, 'Nova'));
    expect(parseAddressing('@brain plan it', r).errors).toEqual([
      expect.objectContaining({ code: 'no_brain' }),
    ]);
  });

  it('an unknown handle is an error with the closest matches', () => {
    const parsed = parseAddressing('@novaa and @draft-writr', team);
    expect(parsed.recipients).toEqual([]);
    expect(parsed.errors).toEqual([
      expect.objectContaining({ code: 'unknown_handle', handle: '@novaa', suggestions: ['@nova'] }),
      expect.objectContaining({
        code: 'unknown_handle',
        handle: '@draft-writr',
        suggestions: ['@draft-writer'],
      }),
    ]);
  });

  it('an @ inside a word (an email address) is not a handle', () => {
    expect(parseAddressing('mail me at me@nova.dev', team)).toMatchObject({
      recipients: [],
      errors: [],
    });
  });
});

describe('D326 @all', () => {
  const team = roster(agent(1, 'Nova'), agent(2, 'Iris'), agent(3, 'Director', { brain: true }));

  it('@all plus a name is an error', () => {
    const parsed = parseAddressing('@all and Nova, look', team);
    expect(parsed.errors).toEqual([expect.objectContaining({ code: 'all_with_others' })]);
  });

  it('@all plus another handle is an error', () => {
    expect(parseAddressing('@all @iris', team).errors).toEqual([
      expect.objectContaining({ code: 'all_with_others' }),
    ]);
  });

  it('the words "all" and "everyone" never mean @all', () => {
    expect(parseAddressing('thanks all, and everyone', team)).toMatchObject({
      all: false,
      recipients: [],
    });
  });

  it('reaches every node that has not finished, the Brain included, and skips the rest', () => {
    const states: Record<string, NodeState> = { [id(1)]: 'RUNNING', [id(2)]: 'COMPLETED' };
    const resolved = resolveAddressing({
      parsed: parseAddressing('@all wrap up', team),
      roster: team,
      states,
      deliveryMode: 'queue',
    });
    expect(resolved).toEqual({
      ok: true,
      addressing: 'all',
      recipients: [id(1), id(3)],
      skipped: [{ nodeId: id(2), reason: 'finished' }],
    });
  });

  it('every node finished → all_finished', () => {
    const states: Record<string, NodeState> = {
      [id(1)]: 'COMPLETED',
      [id(2)]: 'FAILED',
      [id(3)]: 'STOPPED',
    };
    const resolved = resolveAddressing({
      parsed: parseAddressing('@all wrap up', team),
      roster: team,
      states,
      deliveryMode: 'queue',
    });
    expect(resolved).toEqual({
      ok: false,
      errors: [
        expect.objectContaining({
          code: 'all_finished',
          message: 'all nodes are done — name the ones you want to redo',
        }),
      ],
    });
  });

  it('@all is queue-only', () => {
    const resolved = resolveAddressing({
      parsed: parseAddressing('@all stop and look', team),
      roster: team,
      states: {},
      deliveryMode: 'interrupt',
    });
    expect(resolved).toEqual({
      ok: false,
      errors: [expect.objectContaining({ code: 'all_queue_only' })],
    });
  });
});

describe('D324/D304 resolving recipients', () => {
  const team = roster(agent(1, 'Nova'), agent(2, 'Iris'), agent(3, 'Director', { brain: true }));

  it('nothing addressed goes to the Brain', () => {
    const resolved = resolveAddressing({
      parsed: parseAddressing('what is the status?', team),
      roster: team,
      states: {},
      deliveryMode: 'queue',
    });
    expect(resolved).toEqual({
      ok: true,
      addressing: 'unaddressed',
      recipients: [id(3)],
      skipped: [],
    });
  });

  it('nothing addressed with no Brain designated is no_brain', () => {
    const r = roster(agent(1, 'Nova'));
    const resolved = resolveAddressing({
      parsed: parseAddressing('what is the status?', r),
      roster: r,
      states: {},
      deliveryMode: 'queue',
    });
    expect(resolved).toEqual({
      ok: false,
      errors: [
        expect.objectContaining({
          code: 'no_brain',
          message: 'address a node by name or @handle',
        }),
      ],
    });
  });

  it('exclude removes a matched recipient', () => {
    const resolved = resolveAddressing({
      parsed: parseAddressing('Nova and Iris, check this', team),
      roster: team,
      states: {},
      deliveryMode: 'queue',
      exclude: [id(2)],
    });
    expect(resolved).toEqual({ ok: true, addressing: 'direct', recipients: [id(1)], skipped: [] });
  });

  it('an exclude entry that was not a match is an error', () => {
    const resolved = resolveAddressing({
      parsed: parseAddressing('Nova, check this', team),
      roster: team,
      states: {},
      deliveryMode: 'queue',
      exclude: [id(2)],
    });
    expect(resolved).toEqual({
      ok: false,
      errors: [expect.objectContaining({ code: 'exclude_not_matched', nodeId: id(2) })],
    });
  });

  it('removing every match leaves the message unaddressed, so it goes to the Brain', () => {
    const resolved = resolveAddressing({
      parsed: parseAddressing('please nova this', team),
      roster: team,
      states: {},
      deliveryMode: 'queue',
      exclude: [id(1)],
    });
    expect(resolved).toEqual({
      ok: true,
      addressing: 'unaddressed',
      recipients: [id(3)],
      skipped: [],
    });
  });

  it('a parse error stops the message whole — nothing half-sends', () => {
    const resolved = resolveAddressing({
      parsed: parseAddressing('Nova and @nobody', team),
      roster: team,
      states: {},
      deliveryMode: 'queue',
    });
    expect(resolved.ok).toBe(false);
  });
});
