import type { Node } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import {
  createApprovalRunHarness,
  SETTLE_MS,
  within,
  type ApprovalRunHarness,
} from '../../__tests__/approval-run-harness.js';
import type { CommandClassifier } from '../../runs/index.js';

/**
 * D376 over the routes and a real run (FR-GRD-006, FR-GRD-013, D342/D348): an agentic node's
 * `run_command` asks with the command on the card; `POST /node-runs/:id/approve { always: true }`
 * adds the prefix to the live run, so the next identical command in the same run runs with no card,
 * and saves it on the workflow's node through the graph service, so the next run asks nothing. The
 * run snapshot is never written (BR-04, D345).
 *
 * The wiring is `approval-run-harness.ts`, the server's own hooks included. The classifier stands in
 * for `@ace/tools`' `classifyCommand`, which the engine may not import: it allows exactly the listed
 * lines and offers the whole line as the prefix unless it holds a substitution.
 */

const classify: CommandClassifier = (command, allowlist) => ({
  autoAllowed: allowlist.includes(command),
  denied: [],
  ...(command.includes('$(') ? {} : { alwaysAllowPrefix: command }),
});

const cards = (h: ApprovalRunHarness): number =>
  h.events.filter((event) => event.type === 'node.approval_required').length;

async function savedNode(h: ApprovalRunHarness, nodeId: string) {
  const { workflow, nodes } = await h.graph.getWorkflowGraph(h.workflowId);
  const node = nodes.find((candidate) => candidate.id === nodeId);
  return {
    version: workflow.version,
    allowed: node?.kind === 'agent' ? node.config.workspace?.allowedCommands : undefined,
  };
}

const snapshotAllowed = (nodes: readonly Node[], nodeId: string) => {
  const node = nodes.find((candidate) => candidate.id === nodeId);
  return node?.kind === 'agent' ? node.config.workspace?.allowedCommands : undefined;
};

describe('D376 Always allow, end to end', () => {
  it('approve with always: the next identical command runs with no card, and the node lists it', async () => {
    const h = await createApprovalRunHarness({ classify });
    const [builder] = await h.seed(['Builder']);
    if (builder === undefined) throw new Error('no Builder');
    const before = await savedNode(h, builder.id);

    const { run, done } = await h.service.beginRun(h.workflowId, {});
    const request = await h.waitForApproval(run.id);
    expect(request).toMatchObject({ nodeId: builder.id, point: 'tool' });
    expect(request.command).toEqual({
      text: 'npm run build',
      allowPrefix: 'npm run build',
      denylisted: false,
    });

    const response = await h.decide(request.nodeRunId, 'approve', { always: true });
    expect(response.status).toBe(200);
    const final = await within(done, SETTLE_MS, "the run's drive");

    expect(final.status).toBe('COMPLETE');
    // Both calls ran; only the first asked.
    expect(h.ran).toEqual(['npm run build', 'npm run build']);
    expect(cards(h)).toBe(1);
    const [nodeRun] = await h.nodeRunsOf(run.id, builder.id);
    expect(nodeRun?.status).toBe('COMPLETED');
    expect(nodeRun?.approvals).toEqual([
      expect.objectContaining({ decision: 'approve', always: true, prefix: 'npm run build' }),
    ]);
    // The first call asked; the second's only verdict is the pass that says why it did not.
    expect(
      (nodeRun?.verdicts ?? []).map(({ checkType, action, passed }) => ({
        checkType,
        action,
        passed,
      })),
    ).toEqual([
      { checkType: 'destructive_action', action: 'ask_user', passed: false },
      { checkType: 'destructive_action', action: 'pass', passed: true },
    ]);

    // The workflow's node lists it, through a normal update: version + 1 and its event.
    const after = await savedNode(h, builder.id);
    expect(after.allowed).toEqual(['npm run build']);
    expect(after.version).toBe(before.version + 1);
    expect(
      h.events.some(
        (event) =>
          event.type === 'workflow.updated' &&
          (event.payload as { version?: number }).version === after.version,
      ),
    ).toBe(true);
    // The run snapshot was written once and never again.
    expect(snapshotAllowed((await h.runRow(run.id)).snapshot.nodes, builder.id)).toEqual([]);

    // The next run starts from the saved node: no card at all.
    const next = await h.service.beginRun(h.workflowId, {});
    expect((await within(next.done, SETTLE_MS, 'the next run')).status).toBe('COMPLETE');
    expect(cards(h)).toBe(1);
    expect(h.ran).toHaveLength(4);
  });

  it('a plain approve asks again for the same command and saves nothing', async () => {
    const h = await createApprovalRunHarness({ classify });
    const [builder] = await h.seed(['Builder']);
    if (builder === undefined) throw new Error('no Builder');
    const before = await savedNode(h, builder.id);

    const { run, done } = await h.service.beginRun(h.workflowId, {});
    const first = await h.waitForApproval(run.id);
    expect((await h.decide(first.nodeRunId, 'approve')).status).toBe(200);
    await h.waitFor(() => cards(h) === 2, 'the second command to ask');
    const second = await h.waitForApproval(run.id);
    expect(second.id).not.toBe(first.id);
    expect((await h.decide(second.nodeRunId, 'approve')).status).toBe(200);

    expect((await within(done, SETTLE_MS, "the run's drive")).status).toBe('COMPLETE');
    expect(await savedNode(h, builder.id)).toEqual(before);
  });

  it('approve with always on a request with no prefix answers 400 and leaves the card up', async () => {
    const h = await createApprovalRunHarness({ classify });
    const [prober] = await h.seed(['Prober']);
    if (prober === undefined) throw new Error('no Prober');
    const before = await savedNode(h, prober.id);

    const { run, done } = await h.service.beginRun(h.workflowId, {});
    const request = await h.waitForApproval(run.id);
    expect(request.command).toEqual({ text: 'echo $(whoami)', denylisted: false });

    const refused = await h.decide(request.nodeRunId, 'approve', { always: true });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({
      error: { code: 'validation_failed', message: "This command can't be always-allowed." },
    });
    expect((await h.nodeRun(request.nodeRunId)).status).toBe('WAITING');
    expect(h.ran).toEqual([]);

    // The card is still answerable the ordinary way.
    expect((await h.decide(request.nodeRunId, 'approve')).status).toBe(200);
    expect((await within(done, SETTLE_MS, "the run's drive")).status).toBe('COMPLETE');
    expect(h.ran).toEqual(['echo $(whoami)']);
    expect(await savedNode(h, prober.id)).toEqual(before);
  });

  it('a classifier that throws makes every command ask: nothing runs without a card', async () => {
    const h = await createApprovalRunHarness({
      classify: () => {
        throw new Error('classifier bug');
      },
    });
    await h.seed(['Builder']);

    const { run, done } = await h.service.beginRun(h.workflowId, {});
    const first = await h.waitForApproval(run.id);
    expect(first.command).toEqual({ text: 'npm run build', denylisted: false });
    expect(h.ran).toEqual([]);
    expect((await h.decide(first.nodeRunId, 'approve')).status).toBe(200);

    await h.waitFor(() => cards(h) === 2, 'the second command to ask too');
    expect(h.ran).toEqual(['npm run build']);
    const second = await h.waitForApproval(run.id);
    expect((await h.decide(second.nodeRunId, 'approve')).status).toBe(200);

    expect((await within(done, SETTLE_MS, "the run's drive")).status).toBe('COMPLETE');
    expect(h.ran).toEqual(['npm run build', 'npm run build']);
  });

  it("a non-agentic node's card is unchanged: no command on it, and nothing to always-allow", async () => {
    const h = await createApprovalRunHarness({ classify });
    await h.seed(['Cleaner']);

    const { run, done } = await h.service.beginRun(h.workflowId, {});
    const request = await h.waitForApproval(run.id);
    expect(request).not.toHaveProperty('command');
    expect(request.preview).toBe('sandbox_delete {"path":"notes.txt"}');

    expect((await h.decide(request.nodeRunId, 'approve', { always: true })).status).toBe(400);
    expect((await h.decide(request.nodeRunId, 'approve')).status).toBe(200);
    expect((await within(done, SETTLE_MS, "the run's drive")).status).toBe('COMPLETE');
    expect(h.deleted).toEqual(['notes.txt']);
  });
});
