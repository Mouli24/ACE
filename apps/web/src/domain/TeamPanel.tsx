import type { DomainCost, DomainUsageSnapshot, FailureReason } from '@ace/contracts';
import { Button, cn, FIELD_LABEL_CLASS, Icons, INPUT_CLASS } from '@ace/ui';
import { useEffect, useId, useState, type ReactNode } from 'react';

import { fmt } from '../theme/constants';
import { Avatar } from '../theme/primitives';
import { failureWords, lookOf, plural, statusPill, type DomainLooks } from './looks';

/**
 * The Team aside (D6, D7, D306, D313) in the theme's Domain view (D336): a card per agent — its
 * state, activity, model, tokens and share of the budget — then the run's TOKEN USE: the total
 * against the budget, each agent's share, input and output, the cost when one is known, and the
 * last turns. Every estimate says so — a node, a total, a turn or a cost that is not all reported
 * carries `est.` — and a cost nobody knows is "—", never 0.
 */

export interface TeamPanelProps {
  usage: DomainUsageSnapshot | null;
  /** Each agent's colour, letter and model (D328); one it lacks gets its place's colour. */
  looks?: DomainLooks;
  /** PG-4.2: why each FAILED agent failed, so its card says which failure it was. */
  failureReasons?: ReadonlyMap<string, FailureReason>;
  /** How many agents the run has, while no usage has arrived. */
  agentCount?: number;
  readOnly?: boolean;
  onSetBudget?(limit: number | null): Promise<unknown>;
  onClose?(): void;
  /** PG-3.4: the node in focus (Domain's lens): its card is marked. */
  focusedNodeId?: string | undefined;
  /** PG-3.4: follow an agent to the canvas. Absent: not offered. */
  onShowOnCanvas?(nodeId: string): void;
}

const count = (value: number): string => value.toLocaleString('en-US');

/** The marker every estimated number carries. */
function Est() {
  return <span className="font-machine text-[10px] font-normal text-[var(--muted)]">est.</span>;
}

function usd(value: number): string {
  return value >= 0.01 || value === 0 ? `$${value.toFixed(2)}` : `$${value.toPrecision(2)}`;
}

/** A cost as D306 has it: "at least" when partial, reported or est.; "—" when nobody knows. */
function Cost({ cost }: { cost: DomainCost | null }) {
  if (cost === null) return <span>—</span>;
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-1">
      {cost.partial && (
        <span className="font-machine text-[10px] font-normal text-[var(--muted)]">at least</span>
      )}
      <span>{usd(cost.usd)}</span>
      {cost.source === 'reported' ? (
        <span className="font-machine text-[10px] font-normal text-[var(--muted)]">reported</span>
      ) : (
        <Est />
      )}
    </span>
  );
}

function Tile({
  label,
  children,
  testId,
}: {
  label: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className="rounded-[9px] border border-[var(--line)] bg-[var(--surface)] px-[10px] py-[9px]"
    >
      <div className="text-[10.5px] text-[var(--muted)]">{label}</div>
      <div className="mt-[3px] font-machine text-[13px] font-medium">{children}</div>
    </div>
  );
}

const pct = (share: number): string => `${Math.min(100, Math.max(0, share * 100))}%`;

export function TeamPanel({
  usage,
  looks,
  failureReasons,
  agentCount,
  readOnly = false,
  onSetBudget,
  onClose,
  focusedNodeId,
  onShowOnCanvas,
}: TeamPanelProps) {
  const [draft, setDraft] = useState('');
  const budgetId = useId();
  useEffect(() => {
    setDraft(
      usage?.budget === null || usage?.budget === undefined ? '' : String(usage.budget.limit),
    );
  }, [usage?.budget?.limit, usage?.budget]);

  const nodes = usage?.perNode ?? [];
  const agents = usage === null ? (agentCount ?? 0) : nodes.length;
  const working = nodes.filter((node) => node.state === 'RUNNING').length;
  const lookAt = (nodeId: string): ReturnType<typeof lookOf> => {
    const index = nodes.findIndex((node) => node.nodeId === nodeId);
    return lookOf(looks, nodeId, nodes[index]?.name ?? '', Math.max(0, index));
  };

  const total = usage === null ? 0 : usage.total.input + usage.total.output;
  const limit = usage?.budget?.limit;
  const turns = (usage?.perTurn ?? []).slice(-12);
  const tallest = Math.max(1, ...turns.map((turn) => turn.input + turn.output));
  const nameOf = new Map(nodes.map((node) => [node.nodeId, node.name]));
  const cost = usage?.costEst ?? null;

  return (
    <aside
      aria-label="Team"
      className="flex w-[330px] shrink-0 flex-col overflow-y-auto border-l border-[var(--line)] bg-[var(--panel)]"
    >
      <div className="flex items-center gap-2 px-[14px] pb-1 pt-[14px]">
        <div className="text-[14px] font-bold">Team</div>
        <span className="whitespace-nowrap text-[11.5px] text-[var(--muted)]">
          {plural(agents, 'agent')} · {working} working
        </span>
        <div className="flex-1" />
        {onClose !== undefined && (
          <button
            type="button"
            title="Close"
            aria-label="Close"
            onClick={onClose}
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-[7px] border border-[var(--line)] bg-transparent text-[var(--ink)] outline-none focus-visible:shadow-[0_0_0_2px_#ef6b3f]"
          >
            <Icons.X aria-hidden size={13} />
          </button>
        )}
      </div>

      {usage === null ? (
        <p className="px-[14px] py-6 text-center text-[13px] text-[var(--muted)]">No usage yet.</p>
      ) : nodes.length === 0 ? (
        <p className="px-[14px] py-6 text-center text-[13px] text-[var(--muted)]">
          No agents in this run
        </p>
      ) : (
        <ul className="flex flex-col gap-[10px] px-[14px] pb-4 pt-[10px]">
          {nodes.map((node, index) => {
            const look = lookOf(looks, node.nodeId, node.name, index);
            const pill = statusPill(node.state);
            const focused = node.nodeId === focusedNodeId;
            return (
              <li
                key={node.nodeId}
                data-testid={`team-node-${node.handle}`}
                aria-current={focused ? 'true' : undefined}
                className={cn(
                  'flex flex-col gap-[10px] rounded-[12px] border bg-[var(--surface)] p-3',
                  focused ? 'border-[var(--ink)]' : 'border-[var(--line)]',
                )}
                style={focused ? { boxShadow: `inset 3px 0 0 ${look.color}` } : undefined}
              >
                <div className="flex items-center gap-[10px]">
                  <Avatar letter={look.letter} color={look.color} size={30} fontSize={12} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13.5px] font-bold">{node.name}</div>
                    <div className="mt-px truncate font-machine text-[10px] text-[var(--muted)]">
                      @{node.handle} · {look.model ?? '—'}
                    </div>
                  </div>
                  <span
                    className="flex h-[22px] shrink-0 items-center gap-[5px] rounded-full px-2 text-[10.5px] font-bold"
                    style={{ background: pill.bg, color: pill.ink }}
                  >
                    <span
                      aria-hidden
                      className="h-[5px] w-[5px] rounded-full"
                      style={{
                        background: pill.ink,
                        animation: pill.pulse ? 'livePulse 1.4s ease-in-out infinite' : 'none',
                      }}
                    />
                    <span data-testid="team-node-state">{pill.label}</span>
                  </span>
                  {onShowOnCanvas !== undefined && (
                    <button
                      type="button"
                      aria-label={`Show ${node.name} on canvas`}
                      title="Show on canvas"
                      onClick={() => onShowOnCanvas(node.nodeId)}
                      className="flex h-[22px] w-[22px] shrink-0 cursor-pointer items-center justify-center rounded-[6px] border-none bg-transparent text-[var(--muted)] outline-none hover:bg-[var(--hover)] hover:text-[var(--ink)] focus-visible:shadow-[0_0_0_2px_#ef6b3f]"
                    >
                      <Icons.LocateFixed aria-hidden size={13} />
                    </button>
                  )}
                </div>
                {node.state === 'FAILED' && failureReasons?.get(node.nodeId) !== undefined && (
                  <div
                    data-testid="team-node-failure"
                    data-reason={failureReasons.get(node.nodeId)}
                    className="text-[11.5px] font-semibold"
                    style={{ color: 'var(--color-status-FAILED)' }}
                  >
                    {failureWords(failureReasons.get(node.nodeId) ?? 'RUN_FAILED')}
                  </div>
                )}
                <div className="rounded-[8px] border border-[var(--line)] bg-[var(--soft)] px-[10px] py-2 text-[12px] text-[var(--muted)]">
                  {node.activity}
                </div>
                <div className="flex flex-col gap-[5px]">
                  <div className="flex items-baseline gap-1.5 text-[11px]">
                    <span className="text-[var(--muted)]">Tokens</span>
                    <span className="flex-1" />
                    <span className="font-machine font-medium">
                      {fmt(node.input + node.output)}
                    </span>
                    <span className="font-machine text-[10px] text-[var(--muted)]">
                      {fmt(node.input)} / {fmt(node.output)}
                    </span>
                    {node.source !== null && node.source !== 'reported' && <Est />}
                  </div>
                  <div className="h-1 overflow-hidden rounded-[2px] bg-[var(--hover)]">
                    <div
                      data-testid="team-node-bar"
                      className="h-full rounded-[2px] transition-[width] duration-[600ms] ease-[ease]"
                      style={{ width: pct(node.budgetShare ?? 0), background: look.color }}
                    />
                  </div>
                  {/* the theme's card has no cost row: shown only when a cost is known (D306) */}
                  {node.costEst !== null && (
                    <div className="flex items-baseline gap-1.5 font-machine text-[10px] text-[var(--muted)]">
                      <span>Cost</span>
                      <span className="flex-1" />
                      <Cost cost={node.costEst} />
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <section
        data-testid="team-totals"
        className="flex flex-col gap-[14px] border-t border-[var(--line)] px-[14px] pb-[18px] pt-4"
      >
        <div className="flex items-center gap-2">
          <span className="font-machine text-[10px] tracking-[0.1em] text-[var(--muted)]">
            TOKEN USE
          </span>
          <span className="flex-1" />
          <span className="text-[11px] text-[var(--muted)]">This run</span>
        </div>
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="text-[30px] font-bold tracking-[-0.02em] [font-variant-numeric:tabular-nums]">
            {usage === null ? '—' : fmt(total)}
          </span>
          {usage !== null && (
            <span className="text-[12px] text-[var(--muted)]">
              {limit === undefined ? 'no budget set' : `of ${fmt(limit)} budget`}
            </span>
          )}
          {usage !== null && usage.total.estimatedShare > 0 && <Est />}
        </div>
        <div className="flex h-2 gap-[2px] overflow-hidden rounded-[4px] bg-[var(--hover)]">
          {nodes.map((node, index) => {
            const tokens = node.input + node.output;
            const of = limit ?? total;
            return (
              <div
                key={node.nodeId}
                className="h-full transition-[width] duration-[600ms] ease-[ease]"
                style={{
                  width: pct(of === 0 ? 0 : tokens / of),
                  background: lookOf(looks, node.nodeId, node.name, index).color,
                }}
              />
            );
          })}
        </div>
        <div
          className={cn(
            'grid gap-2',
            cost === null
              ? 'grid-cols-[repeat(2,minmax(0,1fr))]'
              : 'grid-cols-[repeat(3,minmax(0,1fr))]',
          )}
        >
          <Tile label="Input">{usage === null ? '—' : fmt(usage.total.input)}</Tile>
          <Tile label="Output">{usage === null ? '—' : fmt(usage.total.output)}</Tile>
          {cost !== null && (
            <Tile label="Est. cost" testId="team-cost">
              <Cost cost={cost} />
            </Tile>
          )}
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex items-baseline text-[11px] text-[var(--muted)]">
            <span>Per turn</span>
            <span className="flex-1" />
            <span className="font-machine text-[10px]">last {turns.length}</span>
          </div>
          <div className="flex h-14 items-end gap-1">
            {turns.map((turn) => {
              const tokens = turn.input + turn.output;
              const name = nameOf.get(turn.nodeId) ?? '?';
              return (
                <div
                  key={turn.turnId}
                  data-testid="team-turn"
                  title={`${name} · ${Math.round(tokens / 1000)}k${turn.source === 'estimated' ? ' est.' : ''}`}
                  className="min-h-[3px] flex-1 rounded-[3px_3px_1px_1px] transition-[height] duration-[400ms] ease-[ease]"
                  style={{
                    height: `${(tokens / tallest) * 100}%`,
                    background: lookAt(turn.nodeId).color,
                  }}
                />
              );
            })}
          </div>
        </div>
      </section>

      {usage !== null && (
        <section
          data-testid="team-budget"
          className="flex flex-col gap-2 border-t border-[var(--line)] px-[14px] pb-[18px] pt-4"
        >
          {usage.budget !== null && usage.budget.level !== 'OK' && (
            <p
              className="text-[12px] font-semibold"
              style={{ color: usage.budget.level === 'EXCEEDED' ? '#c94c27' : '#e8572e' }}
            >
              {usage.budget.level} · {count(usage.budget.used)} / {count(usage.budget.limit)} tokens
            </p>
          )}
          {!readOnly && onSetBudget !== undefined && (
            <form
              className="flex flex-col gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                const next = Number(draft);
                if (Number.isInteger(next) && next > 0) void onSetBudget(next);
              }}
            >
              <label htmlFor={budgetId} className={FIELD_LABEL_CLASS}>
                Token budget
              </label>
              <div className="flex items-center gap-2">
                <input
                  id={budgetId}
                  type="number"
                  min={1}
                  className={cn(INPUT_CLASS, 'min-w-0 flex-1')}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                />
                <Button type="submit" size="sm">
                  Set budget
                </Button>
              </div>
              {usage.budget !== null && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="self-start"
                  onClick={() => void onSetBudget(null)}
                >
                  Remove budget
                </Button>
              )}
            </form>
          )}
        </section>
      )}
    </aside>
  );
}
