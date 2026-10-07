import type { Node } from '@ace/contracts';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { useSelectionStore } from '../app/stores/selection';
import { BUILTIN_SKILL_IDS } from '../mocks/builtin-skills';
import { createNode } from '../nodes/factory';
import { db, installMockServer, renderApp } from '../test/app';
import { peekGraphSync } from '../workflows/sync-registry';

installMockServer();

vi.mock('../canvas/Canvas', () => ({
  Canvas: ({ workflowId }: { workflowId: string }) => <div data-testid="canvas">{workflowId}</div>,
}));

vi.mock('./monaco-loader', () => ({
  MonacoEditor: () => <textarea aria-label="JSON schema" />,
}));

/**
 * FR-SKL-002 D272: the Agent's Skills section — a checkbox per installed skill, with its Built-in
 * badge and description, saved as `skillIds` through the same update_node path as every other
 * field; a link to the Library; and a note when a ticked skill is no longer installed.
 */

const GONE = '01K6SKGNE00000000000000000';

async function openAgent(skillIds: string[] = []) {
  const project = db.createProject({ name: 'P' });
  const workflow = db.createWorkflow(project.id, 'F');
  const node = createNode('agent', workflow.id, { x: 0, y: 0 });
  if (node.kind !== 'agent') throw new Error('not an agent');
  db.commitGraph(workflow.id, [{ ...node, config: { ...node.config, skillIds } }], []);
  const { router } = renderApp(`/projects/${project.id}/workflows/${workflow.id}`);
  await screen.findByTestId('canvas');
  await userEvent.click(screen.getByTestId('sheet-toggle'));
  await screen.findByText(/select a node/i);
  act(() => useSelectionStore.getState().setSelection([node.id], []));
  const panel = await screen.findByRole('complementary', { name: /node configuration/i });
  const field = within(within(panel).getByTestId('agent-skills'));
  return { workflow, node, field, router, user: userEvent.setup() };
}

const skillIdsOf = (workflowId: string, id: string): string[] => {
  const node = db.nodesOf(workflowId).find((n) => n.id === id) as Node;
  if (node.kind !== 'agent') throw new Error('kind changed');
  return node.config.skillIds;
};

async function settled(workflowId: string) {
  await peekGraphSync(workflowId)?.whenIdle();
}

describe('FR-SKL-002 D272 the Agent chooses its skills', () => {
  it('lists every installed skill with its badge and description', async () => {
    const { field } = await openAgent();
    const testFirst = within(
      await field.findByTestId(`agent-skill-${BUILTIN_SKILL_IDS.testFirst}`),
    );
    expect(testFirst.getByLabelText('Test first')).not.toBeChecked();
    expect(testFirst.getByText('Built-in')).toBeInTheDocument();
    expect(
      testFirst.getByText('Write a failing test that describes the change, then make it pass.'),
    ).toBeInTheDocument();
    expect(field.getAllByRole('checkbox')).toHaveLength(5);
    expect(field.getByRole('link', { name: 'Manage skills in the Library' })).toHaveAttribute(
      'href',
      '/library/skills',
    );
  });

  it('saves the ticked skills as skillIds, in the order they were ticked', async () => {
    const { field, user, workflow, node } = await openAgent();
    await user.click(await field.findByLabelText('Security review'));
    await user.click(field.getByLabelText('Test first'));
    await settled(workflow.id);
    await waitFor(() =>
      expect(skillIdsOf(workflow.id, node.id)).toEqual([
        BUILTIN_SKILL_IDS.securityReview,
        BUILTIN_SKILL_IDS.testFirst,
      ]),
    );

    await user.click(field.getByLabelText('Security review'));
    await settled(workflow.id);
    await waitFor(() =>
      expect(skillIdsOf(workflow.id, node.id)).toEqual([BUILTIN_SKILL_IDS.testFirst]),
    );
  });

  it('shows a ticked skill that is no longer installed, and removes it', async () => {
    const { field, user, workflow, node } = await openAgent([BUILTIN_SKILL_IDS.testFirst, GONE]);
    expect(await field.findByLabelText('Test first')).toBeChecked();
    const note = await field.findByTestId(`agent-skill-missing-${GONE}`);
    expect(note).toHaveTextContent('no longer installed');

    await user.click(within(note).getByRole('button', { name: 'Remove' }));
    await settled(workflow.id);
    await waitFor(() =>
      expect(skillIdsOf(workflow.id, node.id)).toEqual([BUILTIN_SKILL_IDS.testFirst]),
    );
    expect(field.queryByTestId(`agent-skill-missing-${GONE}`)).toBeNull();
  });
});
