import type { Edge, GraphOp, Node } from '@ace/contracts';
import { FIELD_LABEL_CLASS, toast } from '@ace/ui';

import { addRunAfter, runAfterCheck, runsAfter } from '../canvas/run-order';
import { HELP_CLASS } from './fields';

/**
 * D373: the node settings' "Runs after" — the other nodes of the workflow, ticked for each one
 * this node waits for. A tick adds an order edge, an untick removes it; a node it cannot wait for
 * (it would make a cycle) is greyed with the reason. Data connections are not listed here: they
 * already make a node wait, and are edited on the Canvas.
 */
export function RunsAfterField({
  workflowId,
  node,
  nodes,
  edges,
  readOnly,
  enqueue,
}: {
  workflowId: string;
  node: Node;
  nodes: readonly Node[];
  edges: readonly Edge[];
  readOnly: boolean;
  enqueue: (ops: GraphOp[]) => void;
}) {
  const links = new Map(runsAfter(edges, node.id).map((edge) => [edge.from.nodeId, edge]));
  const others = nodes.filter((each) => each.id !== node.id);

  const toggle = (afterId: string, on: boolean) => {
    if (readOnly) return;
    if (!on) {
      const edge = links.get(afterId);
      if (edge !== undefined) enqueue([{ op: 'delete_edge', edgeId: edge.id }]);
      return;
    }
    const outcome = addRunAfter(workflowId, nodes, edges, node.id, afterId);
    if (!outcome.ok) {
      toast.error('Not added', { description: outcome.reason });
      return;
    }
    enqueue(outcome.ops);
  };

  return (
    <section
      aria-label="Runs after"
      data-testid="settings-runs-after"
      className="flex flex-col gap-[7px]"
    >
      <h3 className={`m-0 ${FIELD_LABEL_CLASS}`} id={`runs-after-${node.id}`}>
        Runs after
      </h3>
      <p className={`m-0 ${HELP_CLASS}`}>
        Tick a node to start this one only once it has finished. Nothing is passed along.
      </p>
      {others.length === 0 ? (
        <p className="m-0 text-[12px] text-[var(--muted)]">There is no other node yet.</p>
      ) : (
        <ul
          aria-labelledby={`runs-after-${node.id}`}
          className="m-0 flex max-h-[180px] list-none flex-col gap-[2px] overflow-y-auto rounded-[10px] border border-[var(--line)] bg-[var(--soft)] p-[6px]"
        >
          {others.map((other) => {
            const checked = links.has(other.id);
            const check = checked ? undefined : runAfterCheck(nodes, edges, node.id, other.id);
            const reason = check !== undefined && !check.ok ? check.reason : undefined;
            const name = other.name || 'Untitled';
            return (
              <li key={other.id}>
                <label
                  className="flex cursor-pointer items-start gap-[8px] rounded-[6px] px-[6px] py-[4px] text-[12.5px] text-[var(--ink)] hover:bg-[var(--hover)] has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-55"
                  title={reason}
                >
                  <input
                    type="checkbox"
                    data-testid={`runs-after-${other.id}`}
                    aria-label={
                      reason === undefined ? `Run after ${name}` : `Run after ${name}: ${reason}`
                    }
                    checked={checked}
                    disabled={readOnly || reason !== undefined}
                    onChange={(event) => toggle(other.id, event.target.checked)}
                    className="mt-[2px] accent-[#ef6b3f]"
                  />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate font-medium">{name}</span>
                    {reason !== undefined && (
                      <span className="text-[11px] text-[var(--muted)]">{reason}</span>
                    )}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
