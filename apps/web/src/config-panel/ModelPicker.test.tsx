import type { Node } from '@ace/contracts';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { useSelectionStore } from '../app/stores/selection';
import { createNode } from '../nodes/factory';
import { useRunStore } from '../runs/run-store';
import { db, installMockServer, renderApp } from '../test/app';
import { peekGraphSync } from '../workflows/sync-registry';

installMockServer();

vi.mock('../canvas/Canvas', () => ({
  Canvas: ({ workflowId }: { workflowId: string }) => <div data-testid="canvas">{workflowId}</div>,
}));

vi.mock('./monaco-loader', () => ({
  MonacoEditor: ({ 'aria-label': label }: { 'aria-label'?: string }) => (
    <textarea aria-label={label ?? 'JSON schema'} />
  ),
}));

async function openAgent(configure: (node: Node) => void = () => undefined) {
  const project = db.createProject({ name: 'P' });
  const workflow = db.createWorkflow(project.id, 'F');
  const provider = db.createProvider({ type: 'mock', name: 'Mock' });
  const node = createNode('agent', workflow.id, { x: 0, y: 0 });
  configure(node);
  db.commitGraph(workflow.id, [node], []);
  renderApp(`/projects/${project.id}/workflows/${workflow.id}`);
  await screen.findByTestId('canvas');
  act(() => useSelectionStore.getState().setSelection([node.id], []));
  const panel = await screen.findByRole('complementary', { name: /node configuration/i });
  return { project, workflow, provider, node, panel, user: userEvent.setup() };
}

const savedConfig = (workflowId: string, nodeId: string) =>
  db.nodesOf(workflowId).find((n) => n.id === nodeId)?.config as {
    providerId?: string;
    modelId?: string;
    routing?: { policy: string; fallbackModelIds: string[] };
  };

describe('TC-NODE-003 the model picker only offers models that fit the node', () => {
  it('lists an incompatible model disabled, with the reason', async () => {
    const { user, panel, provider } = await openAgent((node) => {
      if (node.kind === 'agent') node.config = { ...node.config, inputTypes: ['text', 'image'] };
    });

    await user.click(within(panel).getByLabelText('Provider'));
    await user.click(await screen.findByRole('option', { name: /Mock · Mock/ }));
    await waitFor(() => expect(savedConfig('', '')).toBeUndefined());

    await user.click(within(panel).getByLabelText('Model'));

    // mock-vision covers text+image, so it is choosable…
    const vision = await screen.findByRole('option', { name: /Mock vision/ });
    expect(vision).not.toHaveAttribute('aria-disabled', 'true');
    // …while a text-only model is listed and disabled, saying what it cannot do.
    const textOnly = screen.getByRole('option', { name: /Mock text — no image input/ });
    expect(textOnly).toHaveAttribute('aria-disabled', 'true');
    // An unavailable model is offered too, with its own reason rather than silence.
    expect(screen.getByRole('option', { name: /Mock retired — unavailable/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(provider.type).toBe('mock');
  });
});

describe('TC-NODE-004 choosing a model saves it and the card follows', () => {
  it('writes providerId and modelId through graph-ops', async () => {
    const { user, panel, workflow, node, provider } = await openAgent();

    await user.click(within(panel).getByLabelText('Provider'));
    await user.click(await screen.findByRole('option', { name: /Mock · Mock/ }));
    await user.click(within(panel).getByLabelText('Model'));
    await user.click(await screen.findByRole('option', { name: /^Mock text$/ }));

    await peekGraphSync(workflow.id)?.whenIdle();
    await waitFor(() => {
      const config = savedConfig(workflow.id, node.id);
      expect(config?.providerId).toBe(provider.id);
      expect(config?.modelId).toBe('mock-text');
    });
  });
});

describe('FR-RTR-001/002 the fallback list is ordered and editable', () => {
  it('appears under the fallback policy, appends, reorders and removes', async () => {
    const { user, panel, workflow, node, provider } = await openAgent((n) => {
      if (n.kind === 'agent') n.config = { ...n.config, providerId: undefined, modelId: undefined };
    });

    await user.click(within(panel).getByLabelText('Provider'));
    await user.click(await screen.findByRole('option', { name: /Mock · Mock/ }));

    expect(within(panel).queryByTestId('fallback-models')).not.toBeInTheDocument();

    await user.click(within(panel).getByLabelText(/routing policy/i));
    await user.click(await screen.findByRole('option', { name: 'fallback' }));
    const editor = await within(panel).findByTestId('fallback-models');

    await user.click(within(editor).getByLabelText('Add a fallback model'));
    await user.click(await screen.findByRole('option', { name: /^Mock text$/ }));
    await user.click(within(editor).getByLabelText('Add a fallback model'));
    await user.click(await screen.findByRole('option', { name: /^Mock JSON$/ }));

    await peekGraphSync(workflow.id)?.whenIdle();
    await waitFor(() =>
      expect(savedConfig(workflow.id, node.id)?.routing?.fallbackModelIds).toEqual([
        'mock-text',
        'mock-json',
      ]),
    );

    await user.click(within(editor).getByLabelText('Move mock-json up'));
    await peekGraphSync(workflow.id)?.whenIdle();
    await waitFor(() =>
      expect(savedConfig(workflow.id, node.id)?.routing?.fallbackModelIds).toEqual([
        'mock-json',
        'mock-text',
      ]),
    );

    await user.click(within(editor).getByLabelText('Remove mock-text'));
    await peekGraphSync(workflow.id)?.whenIdle();
    await waitFor(() =>
      expect(savedConfig(workflow.id, node.id)?.routing?.fallbackModelIds).toEqual(['mock-json']),
    );
    expect(provider.keySet).toBe(false);
  });
});

describe('TC-NODE-008 an edit during a run applies to the next run', () => {
  it('says so while a run is in flight, and stops saying it when the run ends', async () => {
    const { panel, workflow } = await openAgent();
    expect(within(panel).queryByTestId('applies-next-run')).not.toBeInTheDocument();

    act(() => useRunStore.getState().begin(workflow.id, '01RUN0000000000000000000000', 'RUNNING'));
    expect(await within(panel).findByTestId('applies-next-run')).toHaveTextContent(
      /edits apply to the next run/i,
    );

    act(() => useRunStore.getState().reset());
    await waitFor(() =>
      expect(within(panel).queryByTestId('applies-next-run')).not.toBeInTheDocument(),
    );
  });
});

describe('FR-PRV-005 a removed provider is called out in the panel', () => {
  it('tells the user to choose another provider', async () => {
    const { panel } = await openAgent((node) => {
      if (node.kind === 'agent') {
        // A valid ULID (26 chars, no I/L/O/U) that no provider has — the engine dropped it.
        node.config = { ...node.config, providerId: '01ZZZ00000000000000000000Z' };
      }
    });
    expect(await within(panel).findByTestId('config-provider-missing')).toHaveTextContent(
      /provider was removed/i,
    );
  });
});
