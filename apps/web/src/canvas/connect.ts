import { isConnectionAllowed, type Edge, type Node, type Port } from '@ace/contracts';

import { wouldCloseCycle } from '../lib/cycle';

export interface ConnectionAttempt {
  source: string | null;
  sourceHandle: string | null;
  target: string | null;
  targetHandle: string | null;
}

export type ConnectionVerdict =
  | { ok: true; source: Port; target: Port; fromNodeId: string; toNodeId: string }
  | {
      ok: false;
      code: 'incompatible_types' | 'single_input_occupied' | 'cycle' | 'unknown_port';
      reason: string;
    };

/**
 * The client-side half of FR-CON-002/003/005: the contract rule (`isConnectionAllowed`) plus the
 * plain-cycle check, run before an edge is drawn so the refusal reason shows at once. The engine
 * runs the same rules again; a 400 from it is surfaced too.
 */
export function checkConnection(
  nodes: readonly Node[],
  edges: readonly Edge[],
  attempt: ConnectionAttempt,
): ConnectionVerdict {
  const from = nodes.find((n) => n.id === attempt.source);
  const to = nodes.find((n) => n.id === attempt.target);
  const source = from?.outputs.find((p) => p.id === attempt.sourceHandle);
  const target = to?.inputs.find((p) => p.id === attempt.targetHandle);
  if (!from || !to || !source || !target) {
    return { ok: false, code: 'unknown_port', reason: 'Connect an output port to an input port.' };
  }
  const into = edges.filter((e) => e.to.portId === target.id).length;
  const check = isConnectionAllowed(source, target, into);
  if (!check.ok) return check;
  if (wouldCloseCycle(edges, from.id, to.id)) {
    return {
      ok: false,
      code: 'cycle',
      reason:
        'A data edge cannot close a cycle. Draw it as a loop edge instead — that is the one cycle a workflow may have.',
    };
  }
  return { ok: true, source, target, fromNodeId: from.id, toNodeId: to.id };
}
