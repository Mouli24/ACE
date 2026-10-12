import type { Node } from '@ace/contracts';
import { screen, waitFor, within } from '@testing-library/react';

import { seedKnowledgeBase } from '../mocks/seeds-round5';
import { createNode, type CanvasNodeKind } from '../nodes/factory';
import { db, installMockServer } from '../test/app';
import { peekGraphSync } from '../workflows/sync-registry';
import { mountSettings, renderSettings } from './settings-harness';

installMockServer();

vi.mock('./monaco-loader', () => ({
  MonacoEditor: () => <textarea aria-label="JSON schema" />,
}));

/** A project with two knowledge bases and one node of `kind` on its Canvas. */
function seed(kind: CanvasNodeKind) {
  const project = db.createProject({ name: 'P' });
  const workflow = db.createWorkflow(project.id, 'F');
  const handbook = seedKnowledgeBase(db, project.id, ['onboarding.md'], { name: 'Handbook' });
  const policies = seedKnowledgeBase(db, project.id, ['release-notes.txt'], { name: 'Policies' });
  const node = createNode(kind, workflow.id, { x: 0, y: 0 });
  db.commitGraph(workflow.id, [node], []);
  return {
    project,
    workflow,
    node,
    handbookId: handbook.knowledgeBaseId,
    policiesId: policies.knowledgeBaseId,
  };
}

/** The node settings modal open on that node (D333). */
async function openPanel(kind: CanvasNodeKind) {
  const seeded = seed(kind);
  const opened = await renderSettings(seeded.project, seeded.workflow, {
    kind: 'node',
    id: seeded.node.id,
  });
  return { ...seeded, ...opened };
}

const saved = (workflowId: string, id: string): Node =>
  db.nodesOf(workflowId).find((n) => n.id === id) as Node;

async function settled(workflowId: string) {
  await peekGraphSync(workflowId)?.whenIdle();
}

describe('FR-RAG-006 / TC-RAG-007 Retrieval node config', () => {
  it('lists the project bases, and saves the base, k and mode through update_node', async () => {
    const { q, user, workflow, node, policiesId } = await openPanel('retrieval');
    // the header's kind chip
    expect(q.getByText('RETRIEVAL')).toBeInTheDocument();

    await user.click(q.getByLabelText('Knowledge base'));
    expect(await screen.findByRole('option', { name: 'Handbook' })).toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: 'Policies' }));

    const k = q.getByLabelText('Results (k)');
    expect(k).toHaveValue(5);
    await user.clear(k);
    await user.type(k, '8');
    await user.tab();

    await user.click(q.getByLabelText('Search mode'));
    await user.click(await screen.findByRole('option', { name: /^keyword/ }));

    await settled(workflow.id);
    await waitFor(() => {
      const node1 = saved(workflow.id, node.id);
      if (node1.kind !== 'retrieval') throw new Error('kind changed');
      expect(node1.config).toEqual({ knowledgeBaseId: policiesId, k: 8, mode: 'keyword' });
      // ports never move: one text query in, json hits out (§2.4)
      expect(node1.inputs.map((p) => p.name)).toEqual(['query']);
      expect(node1.outputs.map((p) => [p.name, p.dataType])).toEqual([['out', 'json']]);
    });
  });

  it('refuses k outside 1–20 inline and never sends it', async () => {
    const { q, user, workflow, node } = await openPanel('retrieval');
    const k = q.getByLabelText('Results (k)');
    await user.clear(k);
    await user.type(k, '21');
    await user.tab();
    expect(await q.findByText('Must be between 1 and 20.')).toBeInTheDocument();
    await settled(workflow.id);
    const node1 = saved(workflow.id, node.id);
    if (node1.kind !== 'retrieval') throw new Error('kind changed');
    expect(node1.config.k).toBe(5);
  });

  it('says so when the project has no knowledge base yet', async () => {
    const project = db.createProject({ name: 'Empty' });
    const workflow = db.createWorkflow(project.id, 'F');
    const node = createNode('retrieval', workflow.id, { x: 0, y: 0 });
    db.commitGraph(workflow.id, [node], []);
    mountSettings(project, workflow, { kind: 'node', id: node.id });
    expect(await screen.findByTestId('retrieval-no-bases')).toHaveTextContent(
      /no knowledge bases in this project/i,
    );
  });
});

describe('FR-RAG-005 Agent "Knowledge bases" multi-select', () => {
  it('attaches and detaches bases, saved as knowledgeBaseIds', async () => {
    const { q, user, workflow, node, handbookId, policiesId } = await openPanel('agent');
    const field = within(q.getByTestId('agent-knowledge-bases'));
    await user.click(await field.findByLabelText('Handbook'));
    await user.click(field.getByLabelText('Policies'));
    await settled(workflow.id);
    await waitFor(() => {
      const agent = saved(workflow.id, node.id);
      if (agent.kind !== 'agent') throw new Error('kind changed');
      expect(agent.config.knowledgeBaseIds).toEqual([handbookId, policiesId]);
    });

    await user.click(field.getByLabelText('Handbook'));
    await settled(workflow.id);
    await waitFor(() => {
      const agent = saved(workflow.id, node.id);
      if (agent.kind !== 'agent') throw new Error('kind changed');
      expect(agent.config.knowledgeBaseIds).toEqual([policiesId]);
      // the rest of the config is untouched (D-001)
      expect(agent.config.memory).toEqual({ enabled: false });
      expect(agent.config.contextPolicy.budgetTokens).toBe(4000);
    });
  });

  it('keeps a deleted base visible so it can be removed', async () => {
    const project = db.createProject({ name: 'P' });
    const workflow = db.createWorkflow(project.id, 'F');
    const node = createNode('agent', workflow.id, { x: 0, y: 0 });
    const ghost = '01ARZ3NDEKTSV4RRFFQ69G5FAZ';
    node.config = { ...node.config, knowledgeBaseIds: [ghost] } as typeof node.config;
    db.commitGraph(workflow.id, [node], []);
    const { user } = await renderSettings(project, workflow, { kind: 'node', id: node.id });
    const missing = await screen.findByTestId(`agent-kb-missing-${ghost}`);
    await user.click(within(missing).getByRole('button', { name: 'Remove' }));
    await settled(workflow.id);
    await waitFor(() => {
      const agent = saved(workflow.id, node.id);
      if (agent.kind !== 'agent') throw new Error('kind changed');
      expect(agent.config.knowledgeBaseIds).toEqual([]);
    });
  });
});

describe('FR-MEM-001 Agent memory toggle', () => {
  it('starts off and saves memory.enabled through update_node, keeping the rest', async () => {
    const { q, user, workflow, node } = await openPanel('agent');
    const toggle = q.getByLabelText('Remember facts between runs');
    expect(toggle).toHaveAttribute('data-state', 'unchecked');
    await user.click(toggle);
    await settled(workflow.id);
    await waitFor(() => {
      const agent = saved(workflow.id, node.id);
      if (agent.kind !== 'agent') throw new Error('kind changed');
      expect(agent.config.memory).toEqual({ enabled: true });
      expect(agent.config.knowledgeBaseIds).toEqual([]);
    });
    await user.click(q.getByLabelText('Remember facts between runs'));
    await settled(workflow.id);
    await waitFor(() => {
      const agent = saved(workflow.id, node.id);
      if (agent.kind !== 'agent') throw new Error('kind changed');
      expect(agent.config.memory).toEqual({ enabled: false });
    });
  });
});
