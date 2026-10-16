import {
  CONTEXT_BUDGET_SHARES,
  contextBudgetSplit,
  effectiveOutputTypes,
  type Edge,
  type Node,
} from '@ace/contracts';
import { FIELD_LABEL_CLASS } from '@ace/ui';

import { HELP_CLASS } from './fields';

/*
 * PG-4.1, before a run: what this node will be handed (BR-02, Arch §12.4). The upstream nodes and
 * ports its envelopes come from, how its context budget is split, the budget its reads are fitted
 * to, and the output contract it is held to — the numbers the engine builds its envelopes with,
 * read from the same helpers (`contextBudgetSplit`, `effectiveOutputTypes`).
 */

const BOX_CLASS =
  'flex flex-col gap-1.5 rounded-[10px] border border-[var(--line)] bg-[var(--soft)] px-3 py-[10px] text-[12px]';
const ROW_CLASS = 'flex items-baseline justify-between gap-3';
const VALUE_CLASS = 'min-w-0 truncate font-machine text-[11.5px] text-[var(--ink)]';

/** The port's name from its id (`<nodeId>:in|out:<name>`), as the node lists it when it can. */
function portName(node: Node | undefined, portId: string): string {
  const port = [...(node?.inputs ?? []), ...(node?.outputs ?? [])].find(
    (each) => each.id === portId,
  );
  return port?.name ?? portId.split(':').pop() ?? portId;
}

/** A JSON schema in one line: its type, and its fields with the required ones marked. */
export function schemaSummary(schema: Record<string, unknown>): string {
  const type = typeof schema.type === 'string' ? schema.type : 'schema';
  const properties =
    typeof schema.properties === 'object' && schema.properties !== null
      ? Object.keys(schema.properties)
      : [];
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((key): key is string => typeof key === 'string')
      : [],
  );
  if (properties.length === 0) return type;
  return `${type} { ${properties.map((key) => (required.has(key) ? `${key}*` : key)).join(', ')} }`;
}

const tokens = (value: number) => `${value.toLocaleString()} tokens`;

export function ReadsSection({
  node,
  nodes,
  edges,
}: {
  node: Node;
  nodes: readonly Node[];
  edges: readonly Edge[];
}) {
  const byId = new Map(nodes.map((each) => [each.id, each]));
  // D373: a "run after" link carries nothing, so it is not something this node reads.
  const incoming = edges.filter((edge) => edge.to.nodeId === node.id && edge.kind !== 'order');
  const split = node.kind === 'agent' ? contextBudgetSplit(node) : undefined;
  const addressable = node.kind === 'agent' || node.kind === 'model';
  const schema = node.kind === 'agent' ? node.config.outputContract?.jsonSchema : undefined;

  return (
    <section aria-label="Reads" data-testid="settings-reads" className="flex flex-col gap-[7px]">
      <h3 className={`m-0 ${FIELD_LABEL_CLASS}`}>Reads</h3>

      <div className={BOX_CLASS}>
        {incoming.length === 0 ? (
          <p className="m-0 text-[var(--muted)]" data-testid="reads-none">
            Nothing upstream — this node starts the run.
          </p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-1 p-0" data-testid="reads-upstream">
            {incoming.map((edge) => {
              const from = byId.get(edge.from.nodeId);
              return (
                <li
                  key={edge.id}
                  className={ROW_CLASS}
                  data-testid={`reads-from-${edge.from.nodeId}`}
                >
                  <span className="min-w-0 truncate">
                    <b className="font-semibold">{from?.name ?? 'a deleted node'}</b>
                    <span className="text-[var(--muted)]">
                      {' '}
                      · {portName(from, edge.from.portId)} → {portName(node, edge.to.portId)}
                    </span>
                  </span>
                  {edge.kind === 'loop' && (
                    <span className="font-machine text-[10.5px] text-[var(--muted)]">loop</span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {split !== undefined && (
        <div className={BOX_CLASS} data-testid="reads-budget">
          <div className={ROW_CLASS}>
            <span className="text-[var(--muted)]">context budget</span>
            <span className={VALUE_CLASS}>{tokens(split.budgetTokens)}</span>
          </div>
          <div className={ROW_CLASS}>
            <span className="text-[var(--muted)]">reads and their summary</span>
            <span className={VALUE_CLASS} data-testid="reads-budget-reads">
              {tokens(split.reads)}
            </span>
          </div>
          <div className={ROW_CLASS}>
            <span className="text-[var(--muted)]">
              retrieved chunks ({Math.round(CONTEXT_BUDGET_SHARES.retrieved * 100)} % with a
              knowledge base)
            </span>
            <span className={VALUE_CLASS}>
              {split.retrieved === 0 ? 'none' : tokens(split.retrieved)}
            </span>
          </div>
          <div className={ROW_CLASS}>
            <span className="text-[var(--muted)]">
              memory ({Math.round(CONTEXT_BUDGET_SHARES.memory * 100)} % with memory on)
            </span>
            <span className={VALUE_CLASS}>
              {split.memory === 0 ? 'none' : tokens(split.memory)}
            </span>
          </div>
          <p className={`m-0 ${HELP_CLASS}`}>
            What does not fit is summarised before the envelope is built, never trimmed after.
          </p>
        </div>
      )}

      {addressable && (
        <div className={BOX_CLASS} data-testid="reads-contract">
          <div className={ROW_CLASS}>
            <span className="text-[var(--muted)]">output contract</span>
            <span className={VALUE_CLASS} data-testid="reads-contract-types">
              {effectiveOutputTypes(node.config).join(', ')}
            </span>
          </div>
          {schema !== undefined && (
            <div className={ROW_CLASS}>
              <span className="text-[var(--muted)]">schema</span>
              <span className={VALUE_CLASS} title={JSON.stringify(schema)}>
                {schemaSummary(schema)}
              </span>
            </div>
          )}
          <div className={ROW_CLASS}>
            <span className="text-[var(--muted)]">max tokens</span>
            <span className={VALUE_CLASS} data-testid="reads-contract-max-tokens">
              {node.config.execution.maxTokens.toLocaleString()}
            </span>
          </div>
        </div>
      )}
    </section>
  );
}
