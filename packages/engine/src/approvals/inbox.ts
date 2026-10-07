import type { Id, PendingApproval, Run } from '@ace/contracts';

import type { Repository, Scope } from '../ports/index.js';

/**
 * The approvals inbox (ACE parity P1, D270): every approval still waiting, across runs, with the
 * run's workflow and project — and its task, when a task started the run — so one list can link to
 * each. The decisions themselves stay where they were: `POST /node-runs/:id/approve` and `/reject`.
 */
export interface ApprovalInbox {
  /** `GET /approvals` — oldest first, so the one that has waited longest is read first. */
  listPending(): Promise<PendingApproval[]>;
}

export interface ApprovalInboxDeps {
  repository: Repository;
  scope: Scope;
}

export function createApprovalInbox({ repository, scope }: ApprovalInboxDeps): ApprovalInbox {
  return {
    async listPending() {
      const requests = await repository.approvals.listPending(scope);
      // Several cards often belong to one run: each run (and its task) is read once.
      const runs = new Map<Id, Promise<{ run: Run; taskId?: Id } | null>>();
      const runOf = (runId: Id) => {
        let found = runs.get(runId);
        if (found === undefined) {
          found = (async () => {
            const run = await repository.runs.get(scope, runId);
            if (run === null) return null;
            const execution = await repository.taskExecutions?.getByRun(scope, runId);
            return execution === null || execution === undefined
              ? { run }
              : { run, taskId: execution.taskId };
          })();
          runs.set(runId, found);
        }
        return found;
      };

      const items: PendingApproval[] = [];
      for (const request of requests) {
        const owner = await runOf(request.runId);
        // A request whose run is no longer stored has nothing to link to.
        if (owner === null) continue;
        items.push({
          request,
          workflowId: owner.run.workflowId,
          projectId: owner.run.projectId,
          ...(owner.taskId === undefined ? {} : { taskId: owner.taskId }),
        });
      }
      return items;
    },
  };
}
