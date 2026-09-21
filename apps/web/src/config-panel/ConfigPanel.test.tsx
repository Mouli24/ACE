import type { Node } from '@ace/contracts';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { useSelectionStore } from '../app/stores/selection';
import { createNode } from '../nodes/factory';
import { db, installMockServer, renderApp } from '../test/app';
import { peekGraphSync } from '../workflows/sync-registry';

installMockServer();

vi.mock('../canvas/Canvas', () => ({
  Canvas: ({ workflowId }: { workflowId: string }) => <div data-testid="canvas">{workflowId}</div>,
}));

vi.mock('@monaco-editor/react', () => ({
  default: ({
    value,
    onChange,
    'aria-label': label,
  }: {
    value?: string;
    onChange?: (v: string | undefined) => void;
    'aria-label'?: string;
  }) => (
    <textarea
      aria-label={label ?? 'JSON schema'}
      data-testid="monaco"
      value={value}
      onChange={(e) => onChange?.(e.target.value)}
    />
  ),
}));

function seed(kind: Parameters<typeof createNode>[0] = 'agent') {
  const project = db.createProject({ name: 'P' });
  const workflow = db.createWorkflow(project.id, 'F');
  const node = createNode(kind, workflow.id, { x: 0, y: 0 });
  db.commitGraph(workflow.id, [node], []);
  return { project, workflow, node };
}

async function openPanel(kind: Parameters<typeof createNode>[0] = 'agent') {
  const seeded = seed(kind);
  renderApp(`/projects/${seeded.project.id}/workflows/${seeded.workflow.id}`);
  await screen.findByTestId('canvas');
  await screen.findByText(/select a node/i);
  act(() => useSelectionStore.getState().setSelection([seeded.node.id], []));
  const panel = await screen.findByRole('complementary', { name: /node configuration/i });
  return { ...seeded, panel, user: userEvent.setup() };
}

async function settled(workflowId: string) {
  await peekGraphSync(workflowId)?.whenIdle();
}

const nodeInDb = (workflowId: string, id: string): Node =>
  db.nodesOf(workflowId).find((n) => n.id === id) as Node;

describe('Config panel (FR-NODE-002/003/007/008)', () => {
  it('TC-NODE-001: selecting an agent shows every §2.4 AgentConfig field', async () => {
    const { panel } = await openPanel('agent');
    const q = within(panel);
    expect(q.getByLabelText(/^name$/i)).toBeInTheDocument();
    expect(q.getByLabelText(/provider/i)).toBeInTheDocument();
    expect(q.getByLabelText(/^model$/i)).toBeInTheDocument();
    expect(q.getByText(/add a provider in round 2/i)).toBeInTheDocument();
    expect(q.getByLabelText(/routing policy/i)).toBeInTheDocument();
    expect(q.getByLabelText(/instructions/i)).toBeInTheDocument();
    expect(q.getByRole('group', { name: /input types/i })).toBeInTheDocument();
    expect(q.getByRole('group', { name: /output types/i })).toBeInTheDocument();
    expect(q.getByLabelText(/json schema/i)).toBeInTheDocument();
    expect(q.getByLabelText(/temperature/i)).toHaveValue(0.7);
    expect(q.getByLabelText(/max tokens/i)).toHaveValue(4096);
    expect(q.getByLabelText(/timeout/i)).toHaveValue(120000);
    expect(q.getByLabelText(/retries/i)).toHaveValue(2);
    expect(q.getByLabelText(/context budget/i)).toHaveValue(4000);
    for (const [label, round] of [
      ['tools', 'Round 4'],
      ['skills', 'Round 6+'],
      ['memory', 'Round 5'],
      ['guardrail policy', 'Round 3'],
      ['knowledge bases', 'Round 5'],
    ] as const) {
      const field = q.getByTestId(`later-${label.replace(/\s+/g, '-')}`);
      expect(field).toHaveTextContent(new RegExp(`available in ${round}`, 'i'));
      expect(field.querySelector('[disabled], [aria-disabled="true"]')).not.toBeNull();
    }
  });

  it('shows a prompt when nothing is selected', async () => {
    seed('agent');
    const { project, workflow } = seed('agent');
    renderApp(`/projects/${project.id}/workflows/${workflow.id}`);
    expect(await screen.findByText(/select a node/i)).toBeInTheDocument();
  });

  it('TC-NODE-002: edits are saved through graph-ops (name, instructions, types, execution, budget)', async () => {
    const { panel, user, workflow, node } = await openPanel('agent');
    const q = within(panel);

    const name = q.getByLabelText(/^name$/i);
    await user.clear(name);
    await user.type(name, 'Writer');
    await user.tab();

    const instructions = q.getByLabelText(/instructions/i);
    await user.type(instructions, 'Write well.');
    await user.tab();

    await user.click(
      within(q.getByRole('group', { name: /output types/i })).getByLabelText('image'),
    );

    const temperature = q.getByLabelText(/temperature/i);
    await user.clear(temperature);
    await user.type(temperature, '0.3');
    await user.tab();

    const budget = q.getByLabelText(/context budget/i);
    await user.clear(budget);
    await user.type(budget, '8000');
    await user.tab();

    await user.click(q.getByLabelText(/routing policy/i));
    await user.click(await screen.findByRole('option', { name: /fallback/i }));

    await settled(workflow.id);
    await waitFor(() => {
      const saved = nodeInDb(workflow.id, node.id);
      expect(saved.name).toBe('Writer');
      if (saved.kind !== 'agent') throw new Error('kind changed');
      expect(saved.config.instructions).toBe('Write well.');
      expect(saved.config.outputTypes).toEqual(['text', 'image']);
      expect(saved.config.execution.temperature).toBe(0.3);
      expect(saved.config.contextPolicy.budgetTokens).toBe(8000);
      expect(saved.config.routing.policy).toBe('fallback');
      expect(saved.outputs.map((p) => p.name)).toEqual(['text', 'image']);
    });
  });

  it('TC-NODE-006: temperature 5 shows an inline error and is never sent', async () => {
    const { panel, user, workflow } = await openPanel('agent');
    const q = within(panel);
    const temperature = q.getByLabelText(/temperature/i);
    await user.clear(temperature);
    await user.type(temperature, '5');
    await user.tab();
    expect(q.getByRole('alert')).toHaveTextContent(/between 0 and 2/i);
    expect(temperature).toHaveAttribute('aria-invalid', 'true');
    await settled(workflow.id);
    expect(db.getWorkflow(workflow.id)?.version).toBe(1);
    expect(nodeInDb(workflow.id, db.nodesOf(workflow.id)[0]!.id).kind === 'agent').toBe(true);
    const saved = nodeInDb(workflow.id, db.nodesOf(workflow.id)[0]!.id);
    expect(saved.kind === 'agent' && saved.config.execution.temperature).toBe(0.7);
  });

  it('TC-NODE-006: every execution range is enforced (max tokens, timeout, retries)', async () => {
    const { panel, user } = await openPanel('agent');
    const q = within(panel);
    for (const [label, bad, message] of [
      [/max tokens/i, '0', /between 1 and 200000/i],
      [/timeout/i, '10', /between 1000 and 600000/i],
      [/retries/i, '6', /between 0 and 5/i],
    ] as const) {
      const field = q.getByLabelText(label);
      await user.clear(field);
      await user.type(field, bad);
      await user.tab();
      expect(q.getAllByRole('alert').some((a) => message.test(a.textContent ?? ''))).toBe(true);
    }
  });

  it('JSON schema editor: invalid JSON is an inline error, valid JSON is saved as outputContract', async () => {
    const { panel, user, workflow, node } = await openPanel('agent');
    const q = within(panel);
    const editor = q.getByLabelText(/json schema/i);
    await user.clear(editor);
    await user.type(editor, '{{ not json');
    expect(q.getByRole('alert')).toHaveTextContent(/valid json/i);
    await user.clear(editor);
    await user.type(editor, '{{"type":"object"}');
    await settled(workflow.id);
    await waitFor(() => {
      const saved = nodeInDb(workflow.id, node.id);
      expect(saved.kind === 'agent' && saved.config.outputContract?.jsonSchema).toEqual({
        type: 'object',
      });
    });
  });

  it('Merge panel: mode all/any (FR-NODE-001)', async () => {
    const { panel, user, workflow, node } = await openPanel('merge');
    const q = within(panel);
    await user.click(q.getByLabelText(/mode/i));
    await user.click(await screen.findByRole('option', { name: /^any$/i }));
    await settled(workflow.id);
    await waitFor(() => {
      const saved = nodeInDb(workflow.id, node.id);
      expect(saved.kind === 'merge' && saved.config.mode).toBe('any');
    });
  });

  it('Transform panel: op and its fields (FR-NODE-013), ports follow the op', async () => {
    const { panel, user, workflow, node } = await openPanel('transform');
    const q = within(panel);
    expect(q.getByLabelText(/template/i)).toBeInTheDocument();
    await user.click(q.getByLabelText(/operation/i));
    await user.click(await screen.findByRole('option', { name: /join/i }));
    const separator = await q.findByLabelText(/separator/i);
    await user.type(separator, ', ');
    await user.tab();
    await settled(workflow.id);
    await waitFor(() => {
      const saved = nodeInDb(workflow.id, node.id);
      expect(saved.kind === 'transform' && saved.config.op).toBe('join');
      expect(saved.kind === 'transform' && saved.config.separator).toBe(', ');
      expect(saved.inputs[0]?.multi).toBe(true);
    });
  });

  it('Input panel: text and output types', async () => {
    const { panel, user, workflow, node } = await openPanel('input');
    const q = within(panel);
    await user.type(q.getByLabelText(/^text$/i, { selector: 'textarea' }), 'hello');
    await user.tab();
    await user.click(
      within(q.getByRole('group', { name: /output types/i })).getByLabelText('file'),
    );
    await settled(workflow.id);
    await waitFor(() => {
      const saved = nodeInDb(workflow.id, node.id);
      expect(saved.kind === 'input' && saved.config.text).toBe('hello');
      expect(saved.outputs.map((p) => p.name)).toEqual(['text', 'file']);
    });
  });

  it('Model panel: system prompt, types and execution settings', async () => {
    const { panel, user, workflow, node } = await openPanel('model');
    const q = within(panel);
    expect(q.getByText(/add a provider in round 2/i)).toBeInTheDocument();
    await user.type(q.getByLabelText(/system prompt/i), 'Be terse.');
    await user.tab();
    await settled(workflow.id);
    await waitFor(() => {
      const saved = nodeInDb(workflow.id, node.id);
      expect(saved.kind === 'model' && saved.config.systemPrompt).toBe('Be terse.');
    });
  });

  it('Output panel explains the node and offers duplicate/delete actions', async () => {
    const { panel } = await openPanel('output');
    const q = within(panel);
    expect(q.getByText(/final result appears here after a run/i)).toBeInTheDocument();
    expect(q.getByRole('button', { name: /delete node/i })).toBeInTheDocument();
  });
});
