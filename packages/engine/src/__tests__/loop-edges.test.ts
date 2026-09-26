import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ApiErrorSchema,
  type Edge,
  type GraphOpsResponse,
  type LoopConfig,
  type Node,
} from '@ace/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { newId } from '../ids.js';
import { LOCAL_SCOPE } from '../ports/index.js';
import {
  addEdge,
  addNode,
  agentNode,
  createHarness,
  createProject,
  createWorkflow,
  edgeBetween,
  graphOps,
  inputNode,
  outputNode,
  post,
  type Harness,
} from './graph-helpers.js';

/**
 * Loop edges through `graph-ops` (FR-CON-007, FR-CON-003, TC-CON-007, round 3 §2.4).
 *
 * The rules themselves are `validateLoopConfig`'s, in `@ace/contracts`, and are tested there. What
 * is tested here is that the engine *asks* it, on both the ops that can create a loop, and turns a
 * refusal into the 400 `validation_failed` §2.6 promises rather than a 500 or a silent accept.
 */

let h: Harness;
let dir: string;

beforeEach(() => {
  h = createHarness();
  dir = mkdtempSync(join(tmpdir(), 'ace-loop-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const LOOP: LoopConfig = {
  maxIterations: 3,
  exitCondition: { path: 'verdict', equals: 'approved' },
  onMax: 'continue',
};

interface Fixture {
  workflowId: string;
  input: Node;
  writer: Node;
  reviewer: Node;
  output: Node;
  version: number;
}

/** Input → Writer (text→text) → Reviewer (text→json) → Output: the §1 Review→Fix shape. */
async function reviewFix(): Promise<Fixture> {
  const project = await createProject(h.app, join(dir, `project-${newId()}`));
  const workflow = await createWorkflow(h.app, project.id);

  const input = inputNode(workflow.id);
  const writer = agentNode(workflow.id, ['text'], ['text']);
  const reviewer = agentNode(workflow.id, ['text'], ['json']);
  const output = outputNode(workflow.id);

  const response = await graphOps(h.app, workflow.id, 0, [
    addNode(input),
    addNode(writer),
    addNode(reviewer),
    addNode(output),
    addEdge(edgeBetween(workflow.id, input.id, 'text', writer.id, 'text')),
    addEdge(edgeBetween(workflow.id, writer.id, 'text', reviewer.id, 'text')),
    addEdge(edgeBetween(workflow.id, reviewer.id, 'json', output.id, 'json')),
  ]);
  expect(response.status).toBe(200);
  const { version } = (await response.json()) as GraphOpsResponse;

  return { workflowId: workflow.id, input, writer, reviewer, output, version };
}

/** The loop edge of the §1 demo: the Reviewer's json back into the Writer's text input. */
function loopEdge(fixture: Fixture, loop: LoopConfig = LOOP): Edge {
  return {
    ...edgeBetween(fixture.workflowId, fixture.reviewer.id, 'json', fixture.writer.id, 'text'),
    kind: 'loop',
    loop,
  };
}

async function refusal(response: Response): Promise<{ code: string; issueCodes: string[] }> {
  const parsed = ApiErrorSchema.parse(await response.json());
  const issues = (parsed.error.details ?? []) as { code: string }[];
  return { code: parsed.error.code, issueCodes: issues.map((issue) => issue.code) };
}

/* -------------------------------------------------------------------------- */

describe('TC-CON-007 Loop limits', () => {
  it('accepts a loop edge that closes a cycle, which a data edge may not', async () => {
    const fixture = await reviewFix();
    const response = await graphOps(h.app, fixture.workflowId, fixture.version, [
      addEdge(loopEdge(fixture)),
    ]);

    expect(response.status).toBe(200);
    const { edges } = (await response.json()) as GraphOpsResponse;
    const loop = edges.find((edge) => edge.kind === 'loop');
    expect(loop?.loop).toEqual(LOOP);
  });

  it.each([0, 51])('refuses maxIterations %i with a 400 validation_failed', async (max) => {
    const fixture = await reviewFix();
    const response = await graphOps(h.app, fixture.workflowId, fixture.version, [
      addEdge(loopEdge(fixture, { ...LOOP, maxIterations: max })),
    ]);

    // `LoopConfigSchema` is part of `EdgeSchema`, so the range is caught as the edge is parsed and
    // the refusal names the field. Either way it is the 400 `validation_failed` §2.6 promises —
    // what TC-CON-007 is about is that neither end of the range gets through.
    expect(response.status).toBe(400);
    const parsed = ApiErrorSchema.parse(await response.json());
    expect(parsed.error.code).toBe('validation_failed');
    expect(JSON.stringify(parsed.error.details)).toContain('maxIterations');
  });

  it('refuses a loop edge with no loop config at all', async () => {
    const fixture = await reviewFix();
    const { loop: _dropped, ...bare } = loopEdge(fixture);

    const response = await graphOps(h.app, fixture.workflowId, fixture.version, [
      addEdge(bare as Edge),
    ]);

    expect(response.status).toBe(400);
    expect((await refusal(response)).issueCodes).toEqual(['loop_config_missing']);
  });

  it.each([1, 50])('accepts the ends of the range, %i', async (max) => {
    const fixture = await reviewFix();
    const response = await graphOps(h.app, fixture.workflowId, fixture.version, [
      addEdge(loopEdge(fixture, { ...LOOP, maxIterations: max })),
    ]);

    expect(response.status).toBe(200);
  });

  it('refuses an exit path that is not a dotted path', async () => {
    const fixture = await reviewFix();
    const response = await graphOps(h.app, fixture.workflowId, fixture.version, [
      addEdge(loopEdge(fixture, { ...LOOP, exitCondition: { path: '$.verdict', equals: 'ok' } })),
    ]);

    expect(response.status).toBe(400);
    expect((await refusal(response)).issueCodes).toEqual(['invalid_loop_config']);
  });

  it('refuses a loop edge whose target is not upstream of its source', async () => {
    const fixture = await reviewFix();
    // Reviewer → Output: the source has a json output, but nothing leads from the Output node back
    // to it, so this closes no cycle and repeats nothing.
    const forwards: Edge = {
      ...edgeBetween(fixture.workflowId, fixture.reviewer.id, 'json', fixture.output.id, 'json'),
      id: newId(),
      kind: 'loop',
      loop: LOOP,
    };

    const response = await graphOps(h.app, fixture.workflowId, fixture.version, [
      addEdge(forwards),
    ]);

    expect(response.status).toBe(400);
    expect((await refusal(response)).issueCodes).toEqual(['loop_target_not_upstream']);
  });

  it('refuses a loop edge whose source has no json output to read', async () => {
    const project = await createProject(h.app, join(dir, `project-${newId()}`));
    const workflow = await createWorkflow(h.app, project.id);
    const input = inputNode(workflow.id);
    const first = agentNode(workflow.id, ['text'], ['text']);
    const second = agentNode(workflow.id, ['text'], ['text']);

    const seeded = await graphOps(h.app, workflow.id, 0, [
      addNode(input),
      addNode(first),
      addNode(second),
      addEdge(edgeBetween(workflow.id, input.id, 'text', first.id, 'text')),
      addEdge(edgeBetween(workflow.id, first.id, 'text', second.id, 'text')),
    ]);
    const { version } = (await seeded.json()) as GraphOpsResponse;

    const response = await graphOps(h.app, workflow.id, version, [
      addEdge({
        ...edgeBetween(workflow.id, second.id, 'text', first.id, 'text'),
        kind: 'loop',
        loop: LOOP,
      }),
    ]);

    expect(response.status).toBe(400);
    expect((await refusal(response)).issueCodes).toEqual(['loop_source_not_json']);
  });

  it('D84 refuses a second loop that would repeat a node the first already repeats', async () => {
    const fixture = await reviewFix();
    const first = await graphOps(h.app, fixture.workflowId, fixture.version, [
      addEdge(loopEdge(fixture)),
    ]);
    const { version } = (await first.json()) as GraphOpsResponse;

    const second = await graphOps(h.app, fixture.workflowId, version, [
      addEdge({ ...loopEdge(fixture), id: newId() }),
    ]);

    expect(second.status).toBe(400);
    expect((await refusal(second)).issueCodes).toEqual(['loop_bodies_overlap']);
  });

  it('refuses a loop config on a data edge', async () => {
    const fixture = await reviewFix();
    const response = await graphOps(h.app, fixture.workflowId, fixture.version, [
      addEdge({ ...loopEdge(fixture), kind: 'data' }),
    ]);

    expect(response.status).toBe(400);
    expect((await refusal(response)).issueCodes).toEqual(['loop_config_on_data_edge']);
  });

  it('the loop back into a single text input does not make the brief a second connection', async () => {
    const fixture = await reviewFix();
    const added = await graphOps(h.app, fixture.workflowId, fixture.version, [
      addEdge(loopEdge(fixture)),
    ]);
    expect(added.status).toBe(200);

    const validated = await post(
      h.app,
      `/api/v1/workflows/${fixture.workflowId}/validate`,
      undefined,
    );
    const { issues } = (await validated.json()) as { issues: { code: string }[] };

    expect(issues.map((issue) => issue.code)).not.toContain('single_input_occupied');
    expect(issues.map((issue) => issue.code)).not.toContain('loop_not_supported');
    expect(issues.map((issue) => issue.code)).not.toContain('cycle');
  });
});

describe('FR-CON-007 update_edge turns an edge into a loop and re-checks it', () => {
  it('stores a loop config the rules accept', async () => {
    const fixture = await reviewFix();
    const bare: Edge = {
      ...edgeBetween(fixture.workflowId, fixture.reviewer.id, 'json', fixture.writer.id, 'text'),
      kind: 'loop',
      loop: LOOP,
    };
    const added = await graphOps(h.app, fixture.workflowId, fixture.version, [addEdge(bare)]);
    const { version } = (await added.json()) as GraphOpsResponse;

    const response = await graphOps(h.app, fixture.workflowId, version, [
      { op: 'update_edge', edgeId: bare.id, patch: { loop: { ...LOOP, maxIterations: 7 } } },
    ]);

    expect(response.status).toBe(200);
    const { edges } = (await response.json()) as GraphOpsResponse;
    expect(edges.find((edge) => edge.id === bare.id)?.loop?.maxIterations).toBe(7);
  });

  it('refuses a maximum of 51 on the way in, and leaves the edge as it was', async () => {
    const fixture = await reviewFix();
    const bare: Edge = {
      ...edgeBetween(fixture.workflowId, fixture.reviewer.id, 'json', fixture.writer.id, 'text'),
      kind: 'loop',
      loop: LOOP,
    };
    const added = await graphOps(h.app, fixture.workflowId, fixture.version, [addEdge(bare)]);
    const { version } = (await added.json()) as GraphOpsResponse;

    const response = await graphOps(h.app, fixture.workflowId, version, [
      { op: 'update_edge', edgeId: bare.id, patch: { loop: { ...LOOP, maxIterations: 51 } } },
    ]);

    expect(response.status).toBe(400);
    const stored = await h.repository.edges.listByWorkflow(LOCAL_SCOPE, fixture.workflowId);
    expect(stored.find((edge) => edge.id === bare.id)?.loop).toEqual(LOOP);
  });

  it('refuses a loop config patched onto a data edge', async () => {
    const fixture = await reviewFix();
    const stored = await h.repository.edges.listByWorkflow(LOCAL_SCOPE, fixture.workflowId);
    const dataEdge = stored[0]!;

    const response = await graphOps(h.app, fixture.workflowId, fixture.version, [
      { op: 'update_edge', edgeId: dataEdge.id, patch: { loop: LOOP } },
    ]);

    expect(response.status).toBe(400);
    expect((await refusal(response)).issueCodes).toEqual(['loop_config_on_data_edge']);
  });
});
