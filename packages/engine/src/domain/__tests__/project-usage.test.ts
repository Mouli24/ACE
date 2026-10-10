import { DomainUsageSnapshotSchema, emptyPricingTable, type PricingTable } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { costOfTurn, findPrice, sumCosts } from '../pricing.js';
import { projectUsage } from '../project-usage.js';
import { RUN, RunLog, agent, nodeId, runOf } from './run-log.js';

/* D306/D313 projectUsage: tokens with their source, costs with theirs, and the budget. */

const PRICING: PricingTable = {
  models: [{ provider: 'anthropic', model: 'claude-sonnet-4-5', inputPer1M: 3, outputPer1M: 15 }],
};

describe('D313 projectUsage — mixed reported and estimated usage', () => {
  const log = new RunLog([agent(1, 'Writer'), agent(2, 'Review')])
    .started()
    .config({ tokenBudget: 10_000 })
    .turn(1, 1, 'draft', {
      tokensIn: 1000,
      tokensOut: 200,
      costUsd: 0.012,
      source: 'reported',
      costSource: 'reported',
      cachedTokensIn: 600,
    })
    .state(2, 2, 'RUNNING')
    .output(2, 2, [{ type: 'text', text: 'ok' }], { tokensIn: 400, tokensOut: 100, costUsd: 0 })
    .turnUsage(
      2,
      2,
      { tokensIn: 400, tokensOut: 100, costUsd: 0, source: 'estimated' },
      'gemini_cli',
      'default',
    )
    .state(2, 2, 'COMPLETED');
  const snapshot = projectUsage(log.events, log.context(), PRICING);

  it('parses against the contract', () => {
    expect(DomainUsageSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });

  it('totals the run, with the share that is estimated and the cached input', () => {
    expect(snapshot.total).toEqual({
      input: 1400,
      output: 300,
      cachedInput: 600,
      estimatedShare: 500 / 1700,
    });
  });

  it('marks each node by where its tokens came from', () => {
    expect(
      snapshot.perNode.map((node) => [node.handle, node.input, node.output, node.source]),
    ).toEqual([
      ['writer', 1000, 200, 'reported'],
      ['review', 400, 100, 'estimated'],
    ]);
  });

  it('a node with turns from both sources is mixed', () => {
    const mixed = new RunLog([agent(1, 'Writer')])
      .started()
      .turn(1, 1, 'a', { tokensIn: 10, tokensOut: 1, costUsd: 0, source: 'reported' })
      .turn(1, 2, 'b', { tokensIn: 10, tokensOut: 1, costUsd: 0, source: 'estimated' });
    expect(projectUsage(mixed.events, mixed.context(), PRICING).perNode[0]?.source).toBe('mixed');
  });

  it('lists every turn, and shows each node its share of the budget', () => {
    expect(snapshot.perTurn.map((turn) => [turn.turnId, turn.source])).toEqual([
      [runOf(1), 'reported'],
      [runOf(2), 'estimated'],
    ]);
    expect(snapshot.budget).toEqual({ limit: 10_000, used: 1700, level: 'OK' });
    expect(snapshot.perNode[0]?.budgetShare).toBeCloseTo(0.12);
  });

  it('reported cost is the provider own; an unpriced estimated turn costs null, so the total is partial', () => {
    expect(snapshot.perNode[0]?.costEst).toEqual({
      usd: 0.012,
      source: 'reported',
      partial: false,
    });
    expect(snapshot.perNode[1]?.costEst).toBeNull();
    expect(snapshot.costEst).toEqual({ usd: 0.012, source: 'reported', partial: true });
  });
});

describe('D306 projectUsage — a missing price', () => {
  const log = new RunLog([agent(1, 'Writer')])
    .started()
    .turn(
      1,
      1,
      'draft',
      { tokensIn: 1000, tokensOut: 100, costUsd: 0.5, source: 'reported', costSource: 'catalog' },
      undefined,
    );

  it('a model ace.pricing.json does not list costs null — never 0, and never the catalog price', () => {
    const turnUsage = {
      tokensIn: 1000,
      tokensOut: 100,
      costUsd: 0.5,
      source: 'reported' as const,
      costSource: 'catalog' as const,
    };
    const withUsage = new RunLog([agent(1, 'Writer')])
      .started()
      .state(1, 1, 'RUNNING')
      .turnUsage(1, 1, turnUsage, 'anthropic', 'claude-opus-4-5')
      .state(1, 1, 'COMPLETED');
    const snapshot = projectUsage(withUsage.events, withUsage.context(), emptyPricingTable());
    expect(snapshot.perTurn[0]?.costEst).toBeNull();
    expect(snapshot.perNode[0]?.costEst).toBeNull();
    expect(snapshot.costEst).toBeNull();
    expect(log.events.length).toBeGreaterThan(0);
  });

  it('a model it does list is estimated from it, per 1M tokens', () => {
    const turnUsage = {
      tokensIn: 1_000_000,
      tokensOut: 100_000,
      costUsd: 0,
      source: 'reported' as const,
    };
    const priced = new RunLog([agent(1, 'Writer')])
      .started()
      .state(1, 1, 'RUNNING')
      .turnUsage(1, 1, turnUsage, 'anthropic', 'claude-sonnet-4-5')
      .state(1, 1, 'COMPLETED');
    expect(projectUsage(priced.events, priced.context(), PRICING).costEst).toEqual({
      usd: 3 + 1.5,
      source: 'estimated',
      partial: false,
    });
  });

  it('prices a run recorded before Domain from its node outputs and provider types', () => {
    const legacy = new RunLog([agent(1, 'Writer')])
      .started()
      .state(1, 1, 'RUNNING')
      .output(1, 1, [{ type: 'text', text: 'x' }], {
        tokensIn: 1_000_000,
        tokensOut: 0,
        costUsd: 0,
      })
      .state(1, 1, 'COMPLETED');
    const providerTypes = new Map([['01JBXQ8Z9KQ4R7N2VWXYZ0PRVD', 'anthropic' as const]]);
    const table: PricingTable = {
      models: [{ provider: 'anthropic', model: 'sonnet', inputPer1M: 2, outputPer1M: 4 }],
    };
    const snapshot = projectUsage(legacy.events, legacy.context(providerTypes), table);
    expect(snapshot.perTurn).toEqual([
      {
        turnId: runOf(1),
        nodeId: nodeId(1),
        input: 1_000_000,
        output: 0,
        source: 'reported',
        costEst: { usd: 2, source: 'estimated', partial: false },
      },
    ]);
  });
});

describe('D313 projectUsage — the budget', () => {
  it('WARN from 80 %, EXCEEDED at 100 %, and a later limit replaces the config one', () => {
    const base = () =>
      new RunLog([agent(1, 'Writer')])
        .started()
        .config({ tokenBudget: 1000 })
        .turn(1, 1, 'x', { tokensIn: 700, tokensOut: 150, costUsd: 0, source: 'reported' });
    expect(projectUsage(base().events, base().context(), emptyPricingTable()).budget?.level).toBe(
      'WARN',
    );
    const over = base().turn(1, 2, 'y', {
      tokensIn: 200,
      tokensOut: 0,
      costUsd: 0,
      source: 'reported',
    });
    expect(projectUsage(over.events, over.context(), emptyPricingTable()).budget).toEqual({
      limit: 1000,
      used: 1050,
      level: 'EXCEEDED',
    });
    const raised = over.push('run.token_budget', {
      runId: RUN,
      limit: 5000,
      used: 1050,
      level: 'SET',
    });
    expect(projectUsage(raised.events, raised.context(), emptyPricingTable()).budget?.level).toBe(
      'OK',
    );
  });

  it('a run with no budget has none', () => {
    const log = new RunLog([agent(1, 'Writer')]).started();
    const snapshot = projectUsage(log.events, log.context(), emptyPricingTable());
    expect(snapshot.budget).toBeNull();
    expect(snapshot.perNode[0]).toMatchObject({
      state: 'IDLE',
      source: null,
      budgetShare: null,
      costEst: null,
    });
  });
});

describe('D303 the team panel activity line', () => {
  it('says what each node is doing, and what is pending for it', () => {
    const log = new RunLog([agent(1, 'Writer'), agent(2, 'Review'), agent(3, 'Fact')])
      .started()
      .state(1, 1, 'RUNNING')
      .push('tool.call', {
        runId: RUN,
        nodeRunId: runOf(1),
        toolCall: {
          id: '01JBXQ8Z9KQ4R7N2VWXYZ0TCA1',
          nodeRunId: runOf(1),
          toolName: 'web_search',
          args: {},
          resultSummary: '3 results',
          durationMs: 40,
          status: 'ok',
          verdicts: [],
          at: '2026-10-10T09:00:05.000Z',
        },
      })
      .human(1, 'Writer, cite sources', [{ node: 1, handle: 'writer' }])
      .instruction(1, 1, 'PENDING')
      .state(2, 2, 'RUNNING')
      .envelope(1, 2, 2, [3], 'QUERY', 'Which year?')
      .state(2, 2, 'WAITING');
    const snapshot = projectUsage(log.events, log.context(), emptyPricingTable());
    expect(snapshot.perNode.map((node) => [node.handle, node.state, node.activity])).toEqual([
      ['writer', 'RUNNING', 'running web_search · 1 message pending'],
      ['review', 'WAITING', 'waiting for an answer from @fact'],
      ['fact', 'IDLE', 'not started'],
    ]);
  });
});

describe('D306 pricing helpers', () => {
  it('finds a price by provider type and the first model id that has one', () => {
    expect(findPrice(PRICING, 'anthropic', [undefined, 'claude-sonnet-4-5'])?.inputPer1M).toBe(3);
    expect(findPrice(PRICING, undefined, ['claude-sonnet-4-5'])).toBeUndefined();
    expect(findPrice(PRICING, 'openai', ['claude-sonnet-4-5'])).toBeUndefined();
  });

  it('sums costs: null when none known, mixed across sources, partial when some are missing', () => {
    expect(sumCosts([])).toBeNull();
    expect(sumCosts([null])).toBeNull();
    expect(
      sumCosts([
        { usd: 1, source: 'reported', partial: false },
        { usd: 2, source: 'estimated', partial: false },
        null,
      ]),
    ).toEqual({ usd: 3, source: 'mixed', partial: true });
    expect(
      costOfTurn(
        { tokensIn: 1, tokensOut: 1, costUsd: 0.4, costSource: 'reported' },
        PRICING,
        undefined,
        [],
      ),
    ).toEqual({
      usd: 0.4,
      source: 'reported',
      partial: false,
    });
  });
});
