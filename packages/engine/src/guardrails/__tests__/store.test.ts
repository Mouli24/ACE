import type { RunApprovalRequest } from '../../ports/index.js';
import type { ApprovalDecision, GuardrailPolicy, Verdict } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { FakeRepository } from '../../__tests__/fake-repository.js';
import { LOCAL_SCOPE, type Scope } from '../../ports/index.js';
import { guardrailStoreFor } from '../store.js';
import { agentNode, check, id, policy as makePolicy, project } from './fakes.js';

/**
 * `guardrailStoreFor` (Arch §7, §15.3) is the one place the wide `Repository` ports are folded down
 * to the narrow `GuardrailStore` interfaces the round-3 services were written against. Every
 * translation more than a rename — the `insert` version split, the `setProjectDefault` id drop and
 * the `recordDecision` "did *my* decision land?" check — is exercised here against `FakeRepository`.
 */
describe('guardrailStoreFor: Repository → GuardrailStore', () => {
  const scope: Scope = LOCAL_SCOPE;

  async function seededProject(repository: FakeRepository): Promise<string> {
    const owner = project();
    await repository.projects.create(scope, owner);
    return owner.id;
  }

  it('insert(policy) creates version 1 and inserts a higher version beside it', async () => {
    const repository = new FakeRepository();
    const projectId = await seededProject(repository);
    const store = guardrailStoreFor(repository, scope);

    const v1: GuardrailPolicy = makePolicy({
      projectId,
      version: 1,
      checks: [check({ point: 'input', type: 'pii', action: 'warn' })],
    });
    const createdBack = await store.policies.insert(scope, v1);
    expect(createdBack.version).toBe(1);

    // Version 2 is an update carrying the version; both rows survive (FR-GRD-001, Arch §13.4).
    const v2: GuardrailPolicy = {
      ...v1,
      version: 2,
      name: 'Renamed',
      updatedAt: '2026-09-27T09:00:00.000Z',
    };
    const updatedBack = await store.policies.insert(scope, v2);
    expect(updatedBack).toMatchObject({ id: v1.id, version: 2, name: 'Renamed' });

    expect((await store.policies.getVersion(scope, v1.id, 1))?.version).toBe(1);
    expect((await store.policies.getVersion(scope, v1.id, 2))?.name).toBe('Renamed');
    expect((await store.policies.getLatest(scope, v1.id))?.version).toBe(2);
  });

  it('insert of a higher version for a vanished policy returns the caller-built row', async () => {
    const repository = new FakeRepository();
    const store = guardrailStoreFor(repository, scope);

    // No version 1 was ever written, so the underlying update finds nothing and returns null;
    // the store answers with the truthful row the caller built rather than inventing one.
    const orphan: GuardrailPolicy = makePolicy({ version: 3 });
    const back = await store.policies.insert(scope, orphan);
    expect(back).toEqual(orphan);
    expect(await store.policies.getLatest(scope, orphan.id)).toBeNull();
  });

  it('listLatest, getProjectDefault and setProjectDefault move the flag off the project id', async () => {
    const repository = new FakeRepository();
    // No project row is seeded here: `projects.create` would add its own default policy and crowd
    // the list, and `insert` never checks the project exists.
    const projectId = id();
    const store = guardrailStoreFor(repository, scope);

    const a = makePolicy({ projectId, name: 'A', isProjectDefault: true });
    const b = makePolicy({ projectId, name: 'B' });
    await store.policies.insert(scope, a);
    await store.policies.insert(scope, b);

    const listed = await store.policies.listLatest(scope, projectId);
    expect(listed.map((p) => p.name).sort()).toEqual(['A', 'B']);

    expect((await store.policies.getProjectDefault(scope, projectId))?.id).toBe(a.id);

    await store.policies.setProjectDefault(scope, projectId, b.id);
    expect((await store.policies.getProjectDefault(scope, projectId))?.id).toBe(b.id);
  });

  it('deleteAllVersions removes every version and answers false when there was nothing', async () => {
    const repository = new FakeRepository();
    const projectId = await seededProject(repository);
    const store = guardrailStoreFor(repository, scope);

    const p = makePolicy({ projectId, version: 1 });
    await store.policies.insert(scope, p);
    await store.policies.insert(scope, { ...p, version: 2 });

    expect(await store.policies.deleteAllVersions(scope, p.id)).toBe(true);
    expect(await store.policies.getLatest(scope, p.id)).toBeNull();
    expect(await store.policies.deleteAllVersions(scope, id())).toBe(false);
  });

  function request(runId: string, nodeRunId: string, nodeId: string): RunApprovalRequest {
    return {
      id: id(),
      runId,
      nodeRunId,
      nodeId,
      nodeName: 'Writer',
      point: 'output',
      checkType: 'pii',
      reason: 'Personal data found: email.',
      preview: 'nobody@example.com',
      requestedAt: '2026-09-27T09:00:00.000Z',
    };
  }

  it('approvals create / get / listPendingByRun / findPendingByNodeRun', async () => {
    const repository = new FakeRepository();
    const store = guardrailStoreFor(repository, scope);
    const runId = id();
    const nodeRunId = id();
    const req = request(runId, nodeRunId, id());

    await store.approvals.create(scope, req);
    expect((await store.approvals.get(scope, req.id))?.request.id).toBe(req.id);
    expect((await store.approvals.listPendingByRun(scope, runId)).map((r) => r.id)).toEqual([
      req.id,
    ]);
    expect((await store.approvals.findPendingByNodeRun(scope, nodeRunId))?.id).toBe(req.id);
  });

  it('recordDecision is true only for the decision that actually landed', async () => {
    const repository = new FakeRepository();
    const store = guardrailStoreFor(repository, scope);
    const runId = id();
    const nodeRunId = id();
    const req = request(runId, nodeRunId, id());
    await store.approvals.create(scope, req);

    const first: ApprovalDecision = {
      requestId: req.id,
      decision: 'approve',
      decidedAt: '2026-09-27T10:00:00.000Z',
    };
    // The first decision is the one that lands: same timestamp and kind come back → true.
    expect(await store.approvals.recordDecision(scope, req.id, first)).toBe(true);

    // A second caller, different timestamp: the store keeps the first, so the timestamps differ → false.
    const laterKind: ApprovalDecision = {
      requestId: req.id,
      decision: 'reject',
      decidedAt: '2026-09-27T10:05:00.000Z',
    };
    expect(await store.approvals.recordDecision(scope, req.id, laterKind)).toBe(false);

    // Same timestamp but a different kind: the timestamp matches, the kind does not → still false.
    const sameTimeOtherKind: ApprovalDecision = {
      requestId: req.id,
      decision: 'reject',
      decidedAt: first.decidedAt,
    };
    expect(await store.approvals.recordDecision(scope, req.id, sameTimeOtherKind)).toBe(false);
  });

  it('recordDecision is false when the request never existed', async () => {
    const repository = new FakeRepository();
    const store = guardrailStoreFor(repository, scope);
    const decision: ApprovalDecision = {
      requestId: id(),
      decision: 'approve',
      decidedAt: '2026-09-27T10:00:00.000Z',
    };
    expect(await store.approvals.recordDecision(scope, decision.requestId, decision)).toBe(false);
  });

  it('verdicts append and list, usage sums the day, and the narrow lookups pass through', async () => {
    const repository = new FakeRepository();
    const projectId = await seededProject(repository);
    const store = guardrailStoreFor(repository, scope);

    const nodeRunId = id();
    const verdict: Verdict = {
      id: id(),
      nodeRunId,
      point: 'output',
      checkType: 'pii',
      action: 'warn',
      passed: false,
      reason: 'Personal data found: email.',
      at: '2026-09-27T09:00:00.000Z',
    };
    await store.verdicts.append(scope, verdict);
    expect((await store.verdicts.listByNodeRun(scope, nodeRunId)).map((v) => v.id)).toEqual([
      verdict.id,
    ]);

    // No node runs recorded that day → zero spend.
    expect(await store.usage.costUsdForDay(scope, '2026-09-27')).toBe(0);

    expect((await store.projects.get(scope, projectId))?.id).toBe(projectId);
    expect(await store.nodeRuns.get(scope, id())).toBeNull();
    expect((await store.settings.get(scope)).dataDir).toBeTypeOf('string');

    const policyId = id();
    const node = agentNode({ guardrailPolicyId: policyId });
    await repository.nodes.insert(scope, node);
    expect(
      (await store.policyUsage.listByGuardrailPolicy(scope, policyId)).map((n) => n.id),
    ).toEqual([node.id]);
  });
});
