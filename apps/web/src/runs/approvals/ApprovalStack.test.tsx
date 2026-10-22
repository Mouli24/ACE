import { zeroUsage, type ApprovalRequest, type Run } from '@ace/contracts';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { api } from '../../app/api';
import { newId } from '../../lib/ulid';
import { createNode } from '../../nodes/factory';
import { db, renderWithQuery, installMockServer } from '../../test/app';
import { ApprovalStack } from './ApprovalStack';

/**
 * The approval card's destructive-tool preview (round 4 §5 item 8, FR-GRD-006, BR-14): a
 * `destructive_action` request names the tool and the args it wants to run, above the card.
 */

installMockServer();

function request(over: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: 'REQ1',
    runId: 'RUN1',
    nodeRunId: 'NR1',
    nodeId: 'N1',
    nodeName: 'Cleaner',
    point: 'tool',
    checkType: 'destructive_action',
    reason: 'sandbox_delete is destructive and needs approval.',
    preview: 'sandbox_delete {"path":"notes.txt"}',
    requestedAt: '2026-09-29T10:00:00.000Z',
    ...over,
  };
}

describe('FR-GRD-006 the approval card previews a destructive tool call', () => {
  it('names the tool and shows its args for a destructive_action request', () => {
    renderWithQuery(<ApprovalStack requests={[request()]} />);

    const preview = screen.getByTestId('approval-tool-preview');
    expect(preview).toBeInTheDocument();
    expect(screen.getByTestId('approval-tool-name')).toHaveTextContent('sandbox_delete');
    expect(screen.getByTestId('approval-tool-args')).toHaveTextContent('"path":"notes.txt"');
  });

  it('shows no tool preview for a non-tool approval', () => {
    renderWithQuery(
      <ApprovalStack
        requests={[
          request({
            id: 'REQ2',
            point: 'output',
            checkType: 'pii',
            preview: 'contact [email redacted] for details',
          }),
        ]}
      />,
    );
    expect(screen.queryByTestId('approval-tool-preview')).not.toBeInTheDocument();
    // The card itself still renders.
    expect(screen.getByTestId('approval-card-NR1')).toBeInTheDocument();
  });
});

describe('D391 Approve all approves only what is not destructive', () => {
  /**
   * A run with three agents WAITING on the engine's approvals, oldest first: an output PII check,
   * a destructive tool call, and a domain check — as `GET /runs/:id/approvals` answers them.
   */
  function seedWaiting() {
    const project = db.createProject({ name: 'P' });
    const workflow = db.createWorkflow(project.id, 'F');
    const agents = ['Writer', 'Cleaner', 'Fetcher'].map((name, index) => ({
      ...createNode('agent', workflow.id, { x: index * 300, y: 0 }),
      name,
    }));
    db.commitGraph(workflow.id, agents, []);
    const run: Run = {
      id: newId(),
      workflowId: workflow.id,
      projectId: project.id,
      status: 'RUNNING',
      snapshot: { version: 1, nodes: agents, edges: [] },
      inputs: {},
      preflightIssues: [],
      totals: zeroUsage(),
      startedAt: new Date().toISOString(),
    };
    db.addRun(run);
    const checks: Array<Partial<ApprovalRequest>> = [
      { point: 'output', checkType: 'pii', preview: 'contact [email redacted]' },
      {
        point: 'tool',
        checkType: 'destructive_action',
        preview: 'sandbox_delete {"path":"notes.txt"}',
      },
      { point: 'tool', checkType: 'domain_allowlist', preview: 'web_fetch example.com' },
    ];
    agents.forEach((agent, index) => {
      const nodeRunId = newId();
      db.upsertNodeRun({
        id: nodeRunId,
        runId: run.id,
        nodeId: agent.id,
        iteration: 1,
        attempt: 1,
        status: 'WAITING',
        inputEnvelopes: [],
        usage: zeroUsage(),
        verdicts: [],
        toolCalls: [],
      });
      db.addApproval(
        request({
          id: newId(),
          runId: run.id,
          nodeRunId,
          nodeId: agent.id,
          nodeName: agent.name,
          reason: 'Needs your approval.',
          requestedAt: new Date(Date.UTC(2026, 9, 21, 10, index)).toISOString(),
          ...checks[index],
        }),
      );
    });
    return run;
  }

  it('three waiting, one destructive: approves the other two in order and leaves it pending', async () => {
    const run = seedWaiting();
    const [writer, cleaner, fetcher] = db.pendingApprovals(run.id);
    const approve = vi.spyOn(api(), 'approveNodeRun');
    renderWithQuery(<ApprovalStack requests={db.pendingApprovals(run.id)} />);

    const button = screen.getByRole('button', { name: 'Approve all (2)' });
    // the one it leaves is named where the button is
    expect(button).toHaveAttribute(
      'title',
      'Approve the 2 that are not destructive, oldest first. Left for you to decide: Cleaner (sandbox_delete)',
    );
    await userEvent.click(button);

    await waitFor(() => expect(db.pendingApprovals(run.id)).toEqual([cleaner]));
    expect(approve.mock.calls.map(([nodeRunId]) => nodeRunId)).toEqual([
      writer!.nodeRunId,
      fetcher!.nodeRunId,
    ]);
    // nothing was rejected: there is no Deny all
    expect(screen.queryByRole('button', { name: /deny all|reject all/i })).toBeNull();
  });

  it('is not offered with one waiting, or with only one that is not destructive', () => {
    const one = request({ id: 'R1', nodeRunId: 'NR1', checkType: 'pii', point: 'output' });
    const { unmount } = renderWithQuery(<ApprovalStack requests={[one]} />);
    expect(screen.queryByTestId('approve-all')).toBeNull();
    unmount();

    renderWithQuery(
      <ApprovalStack
        requests={[one, request({ id: 'R2', nodeRunId: 'NR2', nodeName: 'Other' })]}
      />,
    );
    // two waiting, but the second is destructive: one card's own Approve is all there is
    expect(screen.queryByTestId('approve-all')).toBeNull();
  });

  it('a command on the risky-command list is left for a person too', () => {
    const plain = (id: string) =>
      request({ id, nodeRunId: `NR-${id}`, point: 'output', checkType: 'pii' });
    renderWithQuery(
      <ApprovalStack
        requests={[
          plain('R1'),
          plain('R2'),
          request({
            id: 'R3',
            nodeRunId: 'NR-R3',
            nodeName: 'Shell',
            point: 'tool',
            checkType: 'tool_allowed',
            preview: 'rm -rf build',
            command: { text: 'rm -rf build', denylisted: true },
          }),
        ]}
      />,
    );
    expect(screen.getByRole('button', { name: 'Approve all (2)' })).toHaveAttribute(
      'title',
      expect.stringContaining('Left for you to decide: Shell'),
    );
  });
});
