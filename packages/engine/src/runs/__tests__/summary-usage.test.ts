import { describe, expect, it } from 'vitest';

import { createSummaryUsageLedger } from '../summary-usage.js';

describe('F5 summariser usage is carried per run and target node', () => {
  it('accumulates, takes and clears', () => {
    const ledger = createSummaryUsageLedger();
    ledger.add('r1', 'n1', { tokensIn: 1, tokensOut: 2, costUsd: 0.5 });
    ledger.add('r1', 'n1', { tokensIn: 3, tokensOut: 4, costUsd: 0.25 });
    ledger.add('r2', 'n1', { tokensIn: 9, tokensOut: 9, costUsd: 9 });

    expect(ledger.take('r1', 'n1')).toEqual({ tokensIn: 4, tokensOut: 6, costUsd: 0.75 });
    expect(ledger.take('r1', 'n1')).toBeUndefined();
    expect(ledger.take('r2', 'n1')?.tokensIn).toBe(9);
  });

  it('drops a run when it ends', () => {
    const ledger = createSummaryUsageLedger();
    ledger.add('r1', 'n1', { tokensIn: 1, tokensOut: 1, costUsd: 0 });
    ledger.dropRun('r1');

    expect(ledger.take('r1', 'n1')).toBeUndefined();
  });
});
