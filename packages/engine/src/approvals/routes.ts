import { ApprovalDecisionRequestSchema, type ApprovalDecisionKind, type Id } from '@ace/contracts';
import { Hono, type Context } from 'hono';

import { HttpError } from '../gateway/errors.js';
import {
  ApprovalAlreadyDecidedError,
  ApprovalNotFoundError,
  type ApprovalService,
} from './index.js';

/**
 * `/runs/:id/approvals`, `/node-runs/:id/approve` and `/node-runs/:id/reject` (§2.5, FR-GRD-013).
 *
 * The route *is* the decision — there is no `{ decision }` field to get wrong — and the body carries
 * only an optional note (§2.2). The answer is the node run, so the UI has the row back without a
 * second request; the states that follow arrive as events.
 *
 * `GET /runs/:id/approvals` answers a **bare array**, not `{ items }`: §2.5 writes it that way and
 * D78 made that explicit, matching `/runs/:id/node-runs`.
 */

export type ApprovalRouter = Hono<{ Variables: { requestId: string } }>;

export const noPendingApproval = (nodeRunId: Id): HttpError =>
  new HttpError(
    'workflow',
    'not_found',
    `Node run ${nodeRunId} is not waiting for an approval.`,
  );

/**
 * A second decision on one request is a state error, not a not-found: the request exists, it has
 * simply already been answered, and `invalid_run_state` is §2.5's code for exactly that.
 */
export const alreadyDecided = (requestId: Id): HttpError =>
  new HttpError(
    'workflow',
    'invalid_run_state',
    `Approval ${requestId} has already been decided.`,
    { requestId },
  );

export const nodeRunNotFound = (nodeRunId: Id): HttpError =>
  new HttpError('workflow', 'not_found', `Node run ${nodeRunId} was not found.`);

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}

export function createApprovalRoutes(approvals: ApprovalService): ApprovalRouter {
  const router: ApprovalRouter = new Hono<{ Variables: { requestId: string } }>();

  router.get('/runs/:id/approvals', async (c) => c.json(await approvals.listPending(c.req.param('id'))));

  const decide = (kind: ApprovalDecisionKind) => async (c: Context) => {
    const { note } = ApprovalDecisionRequestSchema.parse(await readJson(c));
    const nodeRunId = c.req.param('id') ?? '';

    try {
      const { nodeRun } = await approvals.decide(nodeRunId, kind, note);
      if (nodeRun === null) throw nodeRunNotFound(nodeRunId);
      return c.json(nodeRun);
    } catch (error) {
      if (error instanceof ApprovalNotFoundError) throw noPendingApproval(nodeRunId);
      if (error instanceof ApprovalAlreadyDecidedError) throw alreadyDecided(error.requestId);
      throw error;
    }
  };

  router.post('/node-runs/:id/approve', decide('approve'));
  router.post('/node-runs/:id/reject', decide('reject'));

  return router;
}
