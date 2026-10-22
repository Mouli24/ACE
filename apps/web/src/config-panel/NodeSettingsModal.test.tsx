import {
  allowedRunActions,
  zeroUsage,
  type ProviderType,
  type ReasoningEffort,
  type Run,
} from '@ace/contracts';
import { screen, waitFor, within } from '@testing-library/react';

import { usePanelsStore } from '../app/stores/panels';
import { useCanvasApi, type CanvasApi } from '../canvas/canvas-api';
import { newId } from '../lib/ulid';
import { createNode } from '../nodes/factory';
import { db, installMockServer } from '../test/app';
import {
  mountSettings,
  nodeInDb,
  openNodeSettings,
  renderSettings,
  seedLoop,
  settled,
} from './settings-harness';

installMockServer();

vi.mock('./monaco-loader', () => ({
  MonacoEditor: ({
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

afterEach(() => useCanvasApi.setState({ api: undefined }));

const agentConfig = (workflowId: string, id: string) => {
  const saved = nodeInDb(workflowId, id);
  if (saved.kind !== 'agent') throw new Error('kind changed');
  return saved.config;
};

describe('Node settings modal shell (D333)', () => {
  it('is a dialog named by the node, with the theme header and footer', async () => {
    const { panel } = await openNodeSettings('agent');
    const dialog = screen.getByRole('dialog', { name: 'Agent' });
    expect(dialog).toHaveAttribute('data-cfg', '1');
    expect(dialog).toContainElement(panel);
    expect(panel).toHaveAttribute('data-testid', 'config-panel');
    // the kind chip replaces the theme's harness chip; the state chip is the live node state
    expect(within(panel).getByText('AGENT')).toBeInTheDocument();
    expect(within(panel).getByText('IDLE')).toBeInTheDocument();
    // an agent shows its stage number on the orb, and which provider and model it runs on
    expect(within(panel).getByTestId('settings-stage')).toHaveTextContent('1');
    expect(within(panel).getByTestId('settings-model-label')).toHaveTextContent('no provider');
    expect(within(panel).getByText('Changes save automatically')).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Done' })).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });

  it('names the provider record and model under the title', async () => {
    const provider = db.createProvider({ type: 'mock', name: 'Mock' });
    const { panel } = await openNodeSettings('agent', (node) => {
      if (node.kind === 'agent')
        node.config = { ...node.config, providerId: provider.id, modelId: 'mock-text' };
    });
    await waitFor(() =>
      expect(within(panel).getByTestId('settings-model-label')).toHaveTextContent(
        'Mock · mock-text',
      ),
    );
  });

  it.each(['Done', 'Close'])('%s closes the modal', async (name) => {
    const { q, user } = await openNodeSettings('agent');
    await user.click(q.getByRole('button', { name }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(usePanelsStore.getState().settings).toBeUndefined();
  });

  it('Esc closes the modal', async () => {
    const { user } = await openNodeSettings('agent');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(usePanelsStore.getState().settings).toBeUndefined();
  });

  it('closes itself when its node is gone', async () => {
    const project = db.createProject({ name: 'P' });
    const workflow = db.createWorkflow(project.id, 'F');
    mountSettings(project, workflow, { kind: 'node', id: '01ZZZ00000000000000000000Z' });
    await waitFor(() => expect(usePanelsStore.getState().settings).toBeUndefined());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('Agent settings (FR-NODE-002/003/007/008, D333)', () => {
  it('TC-NODE-001: shows the theme fields, then every other AgentConfig field', async () => {
    const { q } = await openNodeSettings('agent');
    expect(q.getByLabelText(/provider/i)).toBeInTheDocument();
    expect(q.getByLabelText(/^model$/i)).toBeInTheDocument();
    // Round 2: with no provider on the engine the picker says where to add one (FR-NODE-003).
    expect(await q.findByText(/add a provider on the providers screen/i)).toBeInTheDocument();
    expect(q.getByLabelText(/persona name/i)).toHaveValue('Agent');
    expect(q.getByLabelText(/persona name/i)).toHaveAttribute('placeholder', 'Name this agent');
    // D333: the node's objective is the theme's system prompt — no Generate, no role prompt
    expect(q.getByLabelText(/system prompt/i)).toHaveAttribute('rows', '8');
    expect(q.queryByRole('button', { name: /generate/i })).toBeNull();
    expect(q.queryByRole('button', { name: /role prompt/i })).toBeNull();
    // D333: removed theme fields with no ACE feature (D389 gave effort one: see below)
    for (const gone of [/harness/i, /permissions/i, /priority/i, /citations/i]) {
      expect(q.queryByText(gone)).toBeNull();
    }
    // D389: the theme's effort is the node's reasoning effort, among the execution settings
    expect(q.getByLabelText('Reasoning effort')).toHaveTextContent('Default');
    expect(q.getByLabelText(/routing policy/i)).toBeInTheDocument();
    expect(q.queryByRole('group', { name: /input types/i })).toBeNull();
    expect(q.queryByRole('group', { name: /output types/i })).toBeNull();
    expect(q.getByTestId('agent-advanced-output')).toBeInTheDocument();
    // Monaco is lazily imported, so its label exists before its control does.
    expect(await q.findByLabelText(/json schema/i)).toBeInTheDocument();
    expect(q.getByLabelText(/temperature/i)).toHaveValue(0.7);
    expect(q.getByLabelText(/max tokens/i)).toHaveValue(4096);
    expect(q.getByLabelText(/timeout/i)).toHaveValue(120000);
    expect(q.getByLabelText(/retries/i)).toHaveValue(2);
    expect(q.getByLabelText(/context budget/i)).toHaveValue(4000);
    expect(q.getByLabelText(/guardrail policy/i)).toBeInTheDocument();
    expect(q.getByTestId('agent-tools-section')).toBeInTheDocument();
    expect(q.getByTestId('agent-memory')).toBeInTheDocument();
    expect(q.getByTestId('agent-knowledge-bases')).toBeInTheDocument();
    expect(q.queryByTestId('later-skills')).toBeNull();
    expect(q.getByRole('button', { name: 'Remove node from canvas' })).toBeInTheDocument();
  });

  it('TC-NODE-002: edits are saved through graph-ops (name, prompt, execution, budget, routing)', async () => {
    const { q, user, workflow, node } = await openNodeSettings('agent');

    const name = q.getByLabelText(/persona name/i);
    await user.clear(name);
    await user.type(name, 'Writer');
    await user.tab();

    await user.type(q.getByLabelText(/system prompt/i), 'Write well.');
    await user.tab();

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
      const config = agentConfig(workflow.id, node.id);
      expect(config.instructions).toBe('Write well.');
      expect(config.execution.temperature).toBe(0.3);
      expect(config.contextPolicy.budgetTokens).toBe(8000);
      expect(config.routing.policy).toBe('fallback');
      // one text port each way: the goal-driven node takes text and answers in text (D285)
      expect(saved.inputs.map((p) => p.name)).toEqual(['text']);
      expect(saved.outputs.map((p) => p.name)).toEqual(['text']);
    });
    // the header follows the saved name
    expect(screen.getByRole('dialog', { name: 'Writer' })).toBeInTheDocument();
  });

  it('saves as you type, without a blur (debounced)', async () => {
    const { q, user, workflow, node } = await openNodeSettings('agent');
    const name = q.getByLabelText(/persona name/i);
    await user.clear(name);
    await user.type(name, 'Scout ');
    // still focused: the save comes from the debounce, and the trailing space being typed stays
    expect(name).toHaveFocus();
    await waitFor(() => expect(nodeInDb(workflow.id, node.id).name).toBe('Scout'), {
      timeout: 3000,
    });
    expect(name).toHaveValue('Scout ');
    await user.type(name, 'Two');
    await waitFor(() => expect(nodeInDb(workflow.id, node.id).name).toBe('Scout Two'), {
      timeout: 3000,
    });
  });

  it('an empty name is never saved, and blur puts the saved one back', async () => {
    const { q, user, workflow, node } = await openNodeSettings('agent');
    const name = q.getByLabelText(/persona name/i);
    await user.clear(name);
    await user.tab();
    expect(name).toHaveValue('Agent');
    await settled(workflow.id);
    expect(nodeInDb(workflow.id, node.id).name).toBe('Agent');
  });

  it.each(['Done', 'Escape'] as const)(
    'closing with %s commits the edit still waiting for its debounce',
    async (how) => {
      const { q, user, workflow, node } = await openNodeSettings('agent');
      await user.type(q.getByLabelText(/system prompt/i), 'Ship it.');
      if (how === 'Done') await user.click(q.getByRole('button', { name: 'Done' }));
      else await user.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      await waitFor(async () => {
        await settled(workflow.id);
        expect(agentConfig(workflow.id, node.id).instructions).toBe('Ship it.');
      });
    },
  );

  it('TC-NODE-006: temperature 5 shows an inline error and is never sent', async () => {
    const { q, user, workflow, node } = await openNodeSettings('agent');
    const temperature = q.getByLabelText(/temperature/i);
    await user.clear(temperature);
    await user.type(temperature, '5');
    await user.tab();
    expect(q.getByRole('alert')).toHaveTextContent(/between 0 and 2/i);
    expect(temperature).toHaveAttribute('aria-invalid', 'true');
    await new Promise((resolve) => setTimeout(resolve, 500));
    await settled(workflow.id);
    expect(db.getWorkflow(workflow.id)?.version).toBe(1);
    expect(agentConfig(workflow.id, node.id).execution.temperature).toBe(0.7);
  });

  it('TC-NODE-006: every execution range is enforced (max tokens, timeout, retries)', async () => {
    const { q, user } = await openNodeSettings('agent');
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
    const { q, user, workflow, node } = await openNodeSettings('agent');
    const editor = await q.findByLabelText(/json schema/i);
    await user.clear(editor);
    await user.type(editor, '{{ not json');
    expect(q.getByRole('alert')).toHaveTextContent(/valid json/i);
    await user.clear(editor);
    await user.type(editor, '{{"type":"object"}');
    await settled(workflow.id);
    await waitFor(() =>
      expect(agentConfig(workflow.id, node.id).outputContract?.jsonSchema).toEqual({
        type: 'object',
      }),
    );
  });

  it('the standard review contract fills the output contract in one press', async () => {
    const { q, user, workflow, node } = await openNodeSettings('agent');
    await user.click(q.getByTestId('use-review-contract'));
    await settled(workflow.id);
    await waitFor(() =>
      expect(agentConfig(workflow.id, node.id).outputContract?.jsonSchema).toHaveProperty(
        'properties.verdict',
      ),
    );
    expect(q.getByTestId('use-review-contract')).toBeDisabled();
  });
});

describe('D389 reasoning effort per node', () => {
  /** An Agent node on a provider of `type`, with `effort` already set (or not). */
  const onProvider = (type: ProviderType, effort?: ReasoningEffort) =>
    openNodeSettings('agent', (node) => {
      const provider = db.createProvider({ type, name: `${type} provider` });
      if (node.kind !== 'agent') return;
      node.config.providerId = provider.id;
      if (effort !== undefined) node.config.execution.reasoningEffort = effort;
    });

  it('offers Default, then Low to Max, and saves the level picked', async () => {
    const { q, user, workflow, node } = await onProvider('claude_code');
    const select = q.getByLabelText('Reasoning effort');
    expect(select).toHaveTextContent('Default');
    expect(await q.findByText('Claude Code takes every level.')).toBeInTheDocument();

    await user.click(select);
    const options = await screen.findAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual([
      'Default',
      'Low',
      'Medium',
      'High',
      'Extra high',
      'Max',
    ]);
    await user.click(screen.getByRole('option', { name: 'High' }));

    await settled(workflow.id);
    await waitFor(() =>
      expect(agentConfig(workflow.id, node.id).execution.reasoningEffort).toBe('high'),
    );
  });

  it('Default writes null — the provider’s own default, no setting sent', async () => {
    const { q, user, workflow, node } = await onProvider('codex_cli', 'max');
    expect(q.getByLabelText('Reasoning effort')).toHaveTextContent('Max');
    expect(
      await q.findByText('Codex takes Low to Extra high; Max is sent as Extra high.'),
    ).toBeInTheDocument();

    await user.click(q.getByLabelText('Reasoning effort'));
    await user.click(await screen.findByRole('option', { name: 'Default' }));

    await settled(workflow.id);
    await waitFor(() =>
      expect(agentConfig(workflow.id, node.id).execution.reasoningEffort).toBeNull(),
    );
  });

  it('is disabled for Gemini CLI, which has no such setting, and says so', async () => {
    const { q } = await onProvider('gemini_cli');
    expect(await q.findByText('Gemini CLI has no reasoning-effort setting.')).toBeInTheDocument();
    expect(q.getByLabelText('Reasoning effort')).toBeDisabled();
  });

  it('an API provider applies it on models that can reason', async () => {
    const { q } = await onProvider('openai');
    expect(
      await q.findByText('Applied by models that can reason; others ignore it.'),
    ).toBeInTheDocument();
    expect(q.getByLabelText('Reasoning effort')).toBeEnabled();
  });
});

describe('Skills are tool groups (D333)', () => {
  it('shows the three skills whose tools are registered, and no Citations', async () => {
    const { q } = await openNodeSettings('agent');
    const group = await q.findByRole('group', { name: 'Skills' });
    const switches = await within(group).findAllByRole('switch');
    expect(switches.map((each) => each.textContent)).toEqual([
      expect.stringContaining('Web search'),
      expect.stringContaining('Edit files'),
      expect.stringContaining('Run commands'),
    ]);
    expect(q.queryByText(/citations/i)).toBeNull();
    // the tools a skill toggles are not listed again under the other tools
    const tools = q.getByTestId('agent-tools-section');
    expect(await within(tools).findByRole('checkbox', { name: 'echo' })).toBeInTheDocument();
    for (const name of ['web_search', 'web_fetch', 'write_file', 'edit_file', 'run_command']) {
      expect(within(tools).queryByTestId(`agent-tool-${name}`)).toBeNull();
    }
  });

  it('toggling a skill adds or removes all of its tools at once', async () => {
    const { q, user, workflow, node } = await openNodeSettings('agent');
    const web = await q.findByRole('switch', { name: /web search/i });
    expect(web).toHaveAttribute('aria-checked', 'false');

    await user.click(web);
    expect(web).toHaveAttribute('aria-checked', 'true');
    await settled(workflow.id);
    await waitFor(() =>
      expect(agentConfig(workflow.id, node.id).tools.enabled).toEqual(['web_search', 'web_fetch']),
    );

    await user.click(q.getByRole('switch', { name: /run commands/i }));
    await user.click(web);
    await settled(workflow.id);
    await waitFor(() =>
      expect(agentConfig(workflow.id, node.id).tools.enabled).toEqual(['run_command']),
    );
  });

  it('a skill is on only when every one of its tools is enabled', async () => {
    const { q } = await openNodeSettings('agent', (node) => {
      if (node.kind === 'agent')
        node.config = { ...node.config, tools: { ...node.config.tools, enabled: ['web_search'] } };
    });
    expect(await q.findByRole('switch', { name: /web search/i })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });
});

describe('Remove node from canvas (D333)', () => {
  it('asks the canvas to remove the node with reconnection, then closes', async () => {
    const removeNodeReconnecting = vi.fn();
    const api: CanvasApi = {
      addNode: vi.fn(),
      deleteNodes: vi.fn(),
      removeNodeReconnecting,
      fitView: vi.fn(),
      duplicateSelection: vi.fn(),
    };
    useCanvasApi.setState({ api });
    const { q, user, node } = await openNodeSettings('agent');
    await user.click(q.getByRole('button', { name: 'Remove node from canvas' }));
    expect(removeNodeReconnecting).toHaveBeenCalledWith(node.id);
    expect(api.deleteNodes).not.toHaveBeenCalled();
    expect(usePanelsStore.getState().settings).toBeUndefined();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('is not offered on a read-only canvas', async () => {
    useCanvasApi.setState({
      api: {
        addNode: vi.fn(),
        deleteNodes: vi.fn(),
        fitView: vi.fn(),
        duplicateSelection: vi.fn(),
        readOnly: true,
      },
    });
    const { q } = await openNodeSettings('agent');
    expect(q.queryByRole('button', { name: 'Remove node from canvas' })).toBeNull();
  });
});

describe('Other node kinds keep their fields in the same shell', () => {
  it('Merge: mode all/any (FR-NODE-001)', async () => {
    const { q, user, workflow, node } = await openNodeSettings('merge');
    expect(q.getByText('MERGE')).toBeInTheDocument();
    expect(q.queryByTestId('settings-stage')).toBeNull();
    await user.click(q.getByLabelText(/mode/i));
    await user.click(await screen.findByRole('option', { name: /^any$/i }));
    await settled(workflow.id);
    await waitFor(() => {
      const saved = nodeInDb(workflow.id, node.id);
      expect(saved.kind === 'merge' && saved.config.mode).toBe('any');
    });
    expect(q.getByTestId('merge-slots-empty')).toBeInTheDocument();
  });

  it('Transform: op and its fields (FR-NODE-013), ports follow the op', async () => {
    const { q, user, workflow, node } = await openNodeSettings('transform');
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

  it('Input: name, text, output types and files', async () => {
    const { q, user, workflow, node } = await openNodeSettings('input');
    expect(q.getByText('INPUT')).toBeInTheDocument();
    expect(q.getByLabelText(/^name$/i)).toHaveValue('Input');
    await user.type(q.getByLabelText(/^text$/i, { selector: 'textarea' }), 'hello');
    await user.tab();
    await user.click(
      within(q.getByRole('group', { name: /output types/i })).getByLabelText('file'),
    );
    expect(q.getByTestId('input-attachments')).toBeInTheDocument();
    await settled(workflow.id);
    await waitFor(() => {
      const saved = nodeInDb(workflow.id, node.id);
      expect(saved.kind === 'input' && saved.config.text).toBe('hello');
      expect(saved.outputs.map((p) => p.name)).toEqual(['text', 'file']);
    });
  });

  it('Model: system prompt, types and execution settings', async () => {
    const { q, user, workflow, node } = await openNodeSettings('model');
    expect(q.getByText('MODEL')).toBeInTheDocument();
    expect(q.getByTestId('settings-stage')).toHaveTextContent('1');
    expect(await q.findByText(/add a provider on the providers screen/i)).toBeInTheDocument();
    // a Model node has no tools, so no skills
    expect(q.queryByRole('group', { name: 'Skills' })).toBeNull();
    expect(q.getByRole('group', { name: /input types/i })).toBeInTheDocument();
    await user.type(q.getByLabelText(/system prompt/i), 'Be terse.');
    await user.tab();
    await settled(workflow.id);
    await waitFor(() => {
      const saved = nodeInDb(workflow.id, node.id);
      expect(saved.kind === 'model' && saved.config.systemPrompt).toBe('Be terse.');
    });
  });

  it('Output: explains the node and offers Remove', async () => {
    const { q } = await openNodeSettings('output');
    expect(q.getByText(/final result appears here after a run/i)).toBeInTheDocument();
    expect(q.getByRole('button', { name: 'Remove node from canvas' })).toBeInTheDocument();
  });

  it('[audit L-1] Output: shows the result its node run recorded in the selected run', async () => {
    const project = db.createProject({ name: 'P' });
    const workflow = db.createWorkflow(project.id, 'F');
    const output = createNode('output', workflow.id, { x: 0, y: 0 });
    db.commitGraph(workflow.id, [output], []);
    const run: Run = {
      id: newId(),
      workflowId: workflow.id,
      projectId: project.id,
      status: 'COMPLETE',
      allowedActions: allowedRunActions('COMPLETE'),
      snapshot: { version: 1, nodes: [output], edges: [] },
      inputs: {},
      preflightIssues: [],
      totals: zeroUsage(),
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
    };
    db.addRun(run);
    db.upsertNodeRun({
      id: newId(),
      runId: run.id,
      nodeId: output.id,
      iteration: 1,
      attempt: 1,
      status: 'COMPLETED',
      inputEnvelopes: [],
      output: [{ type: 'text', text: 'The final answer.' }],
      usage: zeroUsage(),
      verdicts: [],
      toolCalls: [],
    });
    const { q } = await renderSettings(project, workflow, { kind: 'node', id: output.id });
    expect(await q.findByText('The final answer.')).toBeInTheDocument();
    expect(q.queryByText(/final result appears here after a run/i)).toBeNull();
    expect(q.getByRole('link', { name: /see the whole run/i })).toHaveAttribute(
      'href',
      `/runs/${run.id}`,
    );
  });
});

describe('Loop edge settings (FR-CON-007, TC-CON-007)', () => {
  it('edits the loop through update_edge in the same shell', async () => {
    const { project, workflow, loop } = seedLoop();
    const { q, user } = await renderSettings(project, workflow, { kind: 'edge', id: loop.id });
    expect(screen.getByRole('dialog', { name: 'Loop edge' })).toBeInTheDocument();
    expect(q.getByText('LOOP')).toBeInTheDocument();
    const editor = q.getByTestId('loop-edge-editor');
    expect(editor).toHaveTextContent('Reviewer sends its output back to Writer.');

    const max = within(editor).getByLabelText(/max iterations/i);
    await user.clear(max);
    await user.type(max, '5');
    await user.tab();
    await settled(workflow.id);
    await waitFor(() =>
      expect(db.edgesOf(workflow.id).find((e) => e.id === loop.id)?.loop?.maxIterations).toBe(5),
    );
  });

  it('refuses 51 inline and saves nothing', async () => {
    const { project, workflow, loop } = seedLoop();
    const { q, user } = await renderSettings(project, workflow, { kind: 'edge', id: loop.id });
    const max = q.getByLabelText(/max iterations/i);
    await user.clear(max);
    await user.type(max, '51');
    await user.tab();
    expect(q.getByRole('alert')).toHaveTextContent(/from 1 to 50/);
    await new Promise((resolve) => setTimeout(resolve, 500));
    await settled(workflow.id);
    expect(db.edgesOf(workflow.id).find((e) => e.id === loop.id)?.loop?.maxIterations).toBe(3);
  });

  it('"Remove loop edge" deletes it and closes', async () => {
    const { project, workflow, loop } = seedLoop();
    const { q, user } = await renderSettings(project, workflow, { kind: 'edge', id: loop.id });
    await user.click(q.getByRole('button', { name: 'Remove loop edge' }));
    expect(usePanelsStore.getState().settings).toBeUndefined();
    await settled(workflow.id);
    await waitFor(() => expect(db.edgesOf(workflow.id).some((e) => e.id === loop.id)).toBe(false));
  });
});
