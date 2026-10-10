import type { DomainCost, DomainUsageSnapshot } from '@ace/contracts';
import { Button } from '@ace/ui';
import { useEffect, useState } from 'react';

/**
 * The team panel (D6, D7, D306, D313): each node's state, activity, tokens and share of the budget;
 * the run's totals, budget, cost and per-turn usage. Every estimate says so — a node, a total, a
 * turn or a cost that is not all reported carries `est.` — and a cost nobody knows is "—", never 0.
 */

export interface TeamPanelProps {
  usage: DomainUsageSnapshot | null;
  readOnly?: boolean;
  onSetBudget?(limit: number | null): Promise<unknown>;
}

const count = (value: number): string => value.toLocaleString('en-US');

/** The marker every estimated number carries. */
function Est() {
  return (
    <span
      className="ml-1 rounded border border-border px-1 text-[10px] text-fg-muted"
      title="estimated"
    >
      est.
    </span>
  );
}

function usd(value: number): string {
  return value >= 0.01 || value === 0 ? `$${value.toFixed(2)}` : `$${value.toPrecision(2)}`;
}

function Cost({ cost }: { cost: DomainCost | null }) {
  if (cost === null) return <span title="no price known">—</span>;
  return (
    <span>
      {cost.partial ? 'at least ' : ''}
      {usd(cost.usd)}
      {cost.source === 'reported' ? <span className="ml-1 text-fg-muted">reported</span> : <Est />}
    </span>
  );
}

export function TeamPanel({ usage, readOnly = false, onSetBudget }: TeamPanelProps) {
  const [draft, setDraft] = useState('');
  useEffect(() => {
    setDraft(
      usage?.budget === null || usage?.budget === undefined ? '' : String(usage.budget.limit),
    );
  }, [usage?.budget?.limit, usage?.budget]);

  if (usage === null) {
    return (
      <aside aria-label="Team" className="p-3 text-sm">
        <p className="text-fg-muted">No usage yet.</p>
      </aside>
    );
  }

  const handleOf = new Map(usage.perNode.map((node) => [node.nodeId, node.handle]));
  const estimated = usage.total.estimatedShare > 0;

  return (
    <aside aria-label="Team" className="flex flex-col gap-3 overflow-y-auto p-3 text-sm">
      <section>
        <h2 className="mb-1 font-semibold">Team</h2>
        <ul className="flex flex-col gap-2">
          {usage.perNode.map((node) => (
            <li
              key={node.nodeId}
              data-testid={`team-node-${node.handle}`}
              className="rounded border border-border p-2"
            >
              <div>
                <strong>@{node.handle}</strong> {node.name}
                {node.brain && <span className="ml-1 text-fg-muted">(Brain)</span>}
              </div>
              <div className="text-xs">
                <span data-testid="team-node-state">{node.state}</span> · {node.activity}
              </div>
              <div className="text-xs">
                {count(node.input)} in · {count(node.output)} out
                {node.source !== null && node.source !== 'reported' && <Est />}
              </div>
              <div className="text-xs">
                cost <Cost cost={node.costEst} />
                {node.budgetShare !== null && (
                  <> · {Math.round(node.budgetShare * 100)}% of budget</>
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section data-testid="team-totals">
        <h2 className="mb-1 font-semibold">Run</h2>
        <div className="text-xs">
          {count(usage.total.input)} in ({count(usage.total.cachedInput)} cached) ·{' '}
          {count(usage.total.output)} out
          {estimated && (
            <>
              <Est />{' '}
              <span className="text-fg-muted">
                {Math.round(usage.total.estimatedShare * 100)}% estimated
              </span>
            </>
          )}
        </div>
      </section>

      <section data-testid="team-cost" className="text-xs">
        Cost <Cost cost={usage.costEst} />
      </section>

      <section data-testid="team-budget" className="text-xs">
        Budget{' '}
        {usage.budget === null ? (
          <span>none</span>
        ) : (
          <span>
            {count(usage.budget.used)} / {count(usage.budget.limit)} tokens · {usage.budget.level}
          </span>
        )}
        {!readOnly && onSetBudget !== undefined && (
          <form
            className="mt-1 flex items-center gap-1"
            onSubmit={(event) => {
              event.preventDefault();
              const limit = Number(draft);
              if (Number.isInteger(limit) && limit > 0) void onSetBudget(limit);
            }}
          >
            <input
              type="number"
              min={1}
              aria-label="Token budget"
              className="w-24 rounded border border-border bg-transparent px-1"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
            <Button type="submit" size="sm">
              Set budget
            </Button>
            {usage.budget !== null && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => void onSetBudget(null)}
              >
                Remove budget
              </Button>
            )}
          </form>
        )}
      </section>

      {usage.perTurn.length > 0 && (
        <section>
          <h2 className="mb-1 font-semibold">Turns</h2>
          <table className="w-full text-xs">
            <thead>
              <tr>
                <th className="text-left">Node</th>
                <th className="text-right">In</th>
                <th className="text-right">Out</th>
                <th className="text-right">Cost</th>
              </tr>
            </thead>
            <tbody>
              {usage.perTurn.map((turn) => (
                <tr key={turn.turnId} data-testid="team-turn">
                  <td>@{handleOf.get(turn.nodeId) ?? '?'}</td>
                  <td className="text-right">{count(turn.input)}</td>
                  <td className="text-right">
                    {count(turn.output)}
                    {turn.source === 'estimated' && <Est />}
                  </td>
                  <td className="text-right">
                    <Cost cost={turn.costEst} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </aside>
  );
}
