import type { Model, Provider } from '@ace/contracts';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type * as ProviderHooks from '../providers/hooks';

import { PALETTE_DRAG_TYPE, PALETTE_INIT_TYPE } from './drag';
import { NewNodeDialog, type NewNodeDialogProps } from './NewNodeDialog';

const { PROVIDERS, MODELS } = vi.hoisted(() => {
  const at = '2026-10-05T00:00:00.000Z';
  const provider = (id: string, type: Provider['type'], name: string, status: Provider['status']) =>
    ({
      id,
      type,
      name,
      keySet: true,
      status,
      concurrency: 20,
      createdAt: at,
      updatedAt: at,
    }) satisfies Provider;
  const model = (id: string, providerId: string, modelId: string, available = true) =>
    ({
      id,
      providerId,
      modelId,
      displayName: modelId,
      inputTypes: ['text'],
      outputTypes: ['text'],
      contextWindow: 200_000,
      supportsTools: true,
      supportsJson: true,
      available,
      source: 'manifest',
      lastCheckedAt: at,
    }) satisfies Model;
  return {
    // the unreachable one is listed first, so the default has to pass it over for a CONNECTED one
    PROVIDERS: [
      provider('p-ollama', 'ollama', 'Local Ollama', 'UNREACHABLE'),
      provider('p-anthropic', 'anthropic', 'Anthropic', 'CONNECTED'),
      provider('p-openai', 'openai', 'OpenAI', 'CONNECTED'),
    ],
    MODELS: [
      model('m1', 'p-anthropic', 'claude-x'),
      model('m2', 'p-anthropic', 'claude-y'),
      model('m3', 'p-anthropic', 'claude-old', false),
      model('m4', 'p-openai', 'gpt-x'),
    ],
  };
});

vi.mock('../providers/hooks', async (importOriginal) => {
  const actual = await importOriginal<typeof ProviderHooks>();
  return {
    ...actual,
    useProviders: () => ({ data: PROVIDERS }),
    useModels: () => ({ data: { items: MODELS, refreshedAt: '2026-10-05T00:00:00.000Z' } }),
  };
});

const WF = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

function renderDialog(over: Partial<NewNodeDialogProps>) {
  const props: NewNodeDialogProps = {
    workflowId: WF,
    workflowName: 'Launch post',
    open: true,
    onClose: vi.fn(),
    onAdd: vi.fn(),
    ...over,
  };
  return { ...render(<NewNodeDialog {...props} />), props };
}

/** The kinds the list currently shows, in order. */
function visibleKinds(): string[] {
  return screen
    .queryAllByTestId(/^palette-/)
    .map((el) => el.getAttribute('data-testid')?.slice('palette-'.length) ?? '');
}

let user: ReturnType<typeof userEvent.setup>;
beforeEach(() => {
  user = userEvent.setup();
});

describe('NewNodeDialog (FR-CAN-002, FR-NODE-001)', () => {
  it('FR-CAN-002 Enter adds the chosen kind with its name, provider and model', async () => {
    const onAdd = vi.fn();
    renderDialog({ onAdd });
    await user.click(screen.getByTestId('palette-agent'));
    await user.type(screen.getByLabelText('Name'), 'Draft');
    await user.keyboard('{Enter}');
    expect(onAdd).toHaveBeenCalledWith('agent', {
      name: 'Draft',
      providerId: 'p-anthropic',
      modelId: 'claude-x',
    });
  });

  it('D285: offers one node — an Agent with a goal — and a double-click adds it', async () => {
    const onAdd = vi.fn();
    const onClose = vi.fn();
    renderDialog({ onAdd, onClose });
    expect(visibleKinds()).toEqual(['agent']);
    for (const gone of [
      'input',
      'output',
      'model',
      'merge',
      'transform',
      'retrieval',
      'guardrail',
      'custom',
    ]) {
      expect(screen.queryByTestId(`palette-${gone}`)).toBeNull();
    }
    // the old left palette's label, kept so suites can scope to the list
    expect(screen.getByRole('group', { name: 'Node palette' })).toContainElement(
      screen.getByTestId('palette-agent'),
    );
    expect(screen.getByTestId('palette-agent')).toHaveAttribute('draggable', 'true');
    expect(screen.getByTestId('palette-agent')).toHaveAttribute(
      'title',
      'Add Agent node (double-click, Enter, or drag onto the Canvas)',
    );
    expect(screen.getByTestId('palette-agent')).toHaveTextContent(
      'An AI model working toward the goal you give it',
    );

    await user.dblClick(screen.getByTestId('palette-agent'));
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onAdd).toHaveBeenCalledWith('agent', { providerId: 'p-anthropic', modelId: 'claude-x' });
    // adding is the dialog's last act
    expect(onClose).toHaveBeenCalled();
  });

  it('FR-NODE-001 Enter on the focused item adds it', async () => {
    const onAdd = vi.fn();
    renderDialog({ onAdd });
    screen.getByTestId('palette-agent').focus();
    await user.keyboard('{Enter}');
    expect(onAdd).toHaveBeenCalledWith('agent', { providerId: 'p-anthropic', modelId: 'claude-x' });
  });

  it('§8.1 zoom 200 %: the preview and details scroll inside their column, never over the Add button', () => {
    renderDialog({});
    // At 200 % browser zoom the window is shorter than the 236 px preview: an unclipped column
    // spilled over the footer and swallowed the click on "Add … to canvas" (manual pass, round 1).
    const column = screen.getByTestId('new-node-details');
    expect(column).toContainElement(screen.getByText('lands at the centre of your view'));
    expect(column).toHaveClass('min-h-0', 'overflow-y-auto');
    expect(column).not.toContainElement(screen.getByTestId('new-node-add'));
  });

  it('the preview is a picture: static port dots, no React Flow handles', () => {
    renderDialog({});
    const card = document.querySelector('[data-kind="agent"][data-testid^="node-card-"]');
    expect(card).not.toBeNull();
    expect(card?.querySelector('.react-flow__handle')).toBeNull();
    expect(card?.querySelectorAll('[data-testid^="port-dot-"]').length).toBeGreaterThan(0);
  });

  it('search filters by name and description, and says when nothing matches', async () => {
    renderDialog({});
    const search = screen.getByRole('searchbox', { name: 'Search node types' });
    await user.type(search, 'goal');
    expect(visibleKinds()).toEqual(['agent']);
    await user.clear(search);
    await user.type(search, 'zzz');
    expect(visibleKinds()).toEqual([]);
    expect(screen.getByText('No node type matches that.')).toBeInTheDocument();
  });

  it('a search that leaves no kind to choose disables the CTA and Enter adds nothing', async () => {
    const onAdd = vi.fn();
    renderDialog({ onAdd });
    const search = screen.getByRole('searchbox', { name: 'Search node types' });
    const cta = () => screen.getByTestId('new-node-add');

    await user.type(search, 'zzz');
    expect(cta()).toBeDisabled();
    // the hidden choice is not offered under another name
    expect(cta()).toHaveTextContent('Add to canvas');
    expect(cta()).not.toHaveTextContent(/agent/i);
    expect(screen.getByText('Nothing to preview')).toBeInTheDocument();
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
    await user.keyboard('{Enter}');
    expect(onAdd).not.toHaveBeenCalled();

    // clearing the query re-enables it, on the choice that is visible again
    await user.clear(search);
    expect(cta()).toBeEnabled();
    expect(cta()).toHaveTextContent('Add agent to canvas');

    // Enter on the choice that is visible again adds it
    await user.keyboard('{Enter}');
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onAdd).toHaveBeenCalledWith('agent', { providerId: 'p-anthropic', modelId: 'claude-x' });
  });

  it('Escape and the overlay close it', async () => {
    const onClose = vi.fn();
    renderDialog({ onClose });
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);

    // a press inside the window does not
    fireEvent.pointerDown(screen.getByRole('dialog'));
    fireEvent.pointerDown(screen.getByTestId('palette-agent'));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.pointerDown(screen.getByTestId('new-node-overlay'));
    expect(onClose).toHaveBeenCalledTimes(2);

    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(3);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(4);
  });

  it('keystrokes inside the dialog never reach Canvas shortcuts on window', async () => {
    const onWindowKey = vi.fn();
    window.addEventListener('keydown', onWindowKey);
    try {
      renderDialog({});
      screen.getByTestId('palette-agent').focus();
      await user.keyboard('f');
      expect(onWindowKey).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', onWindowKey);
    }
  });

  it('drag carries the kind and init and hides the overlay', () => {
    const onClose = vi.fn();
    renderDialog({ onClose });
    const data = new Map<string, string>();
    const dataTransfer = { setData: (k: string, v: string) => data.set(k, v), effectAllowed: '' };
    fireEvent.dragStart(screen.getByTestId('palette-agent'), { dataTransfer });
    expect(data.get(PALETTE_DRAG_TYPE)).toBe('agent');
    expect(JSON.parse(data.get(PALETTE_INIT_TYPE) ?? 'null')).toEqual({
      providerId: 'p-anthropic',
      modelId: 'claude-x',
    });
    expect(dataTransfer.effectAllowed).toBe('move');
    expect(screen.getByRole('dialog', { hidden: true }).className).toMatch(/pointer-events-none/);
    expect(screen.getByTestId('new-node-overlay').className).toMatch(/pointer-events-none/);
    expect(screen.getByTestId('new-node-overlay').className).toMatch(/opacity-0/);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.dragEnd(screen.getByTestId('palette-agent'), { dataTransfer });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a dragged Agent carries the name, provider and model chosen for it', async () => {
    renderDialog({});
    await user.click(screen.getByTestId('palette-agent'));
    await user.type(screen.getByLabelText('Name'), '  Draft  ');
    const data = new Map<string, string>();
    const dataTransfer = { setData: (k: string, v: string) => data.set(k, v), effectAllowed: '' };
    fireEvent.dragStart(screen.getByTestId('palette-agent'), { dataTransfer });
    expect(data.get(PALETTE_DRAG_TYPE)).toBe('agent');
    expect(JSON.parse(data.get(PALETTE_INIT_TYPE) ?? 'null')).toEqual({
      name: 'Draft',
      providerId: 'p-anthropic',
      modelId: 'claude-x',
    });
  });

  it('provider grid: first CONNECTED provider by default, its models, and a switch', async () => {
    const onAdd = vi.fn();
    renderDialog({ onAdd });
    await user.click(screen.getByTestId('palette-agent'));

    const providers = screen.getByRole('group', { name: 'Provider' });
    const anthropic = screen.getByRole('button', { name: /^Anthropic/ });
    const ollama = screen.getByRole('button', { name: /^Local Ollama/ });
    expect(providers).toContainElement(anthropic);
    expect(anthropic).toHaveAttribute('aria-pressed', 'true');
    expect(anthropic).toHaveTextContent('2 models');
    expect(ollama).toHaveAttribute('aria-pressed', 'false');
    expect(ollama).toHaveTextContent('unreachable');

    // the chosen provider's models; one the provider no longer offers is listed but disabled
    const models = screen.getByRole('group', { name: 'Model' });
    expect(models).toHaveTextContent('claude-x');
    expect(screen.getByRole('button', { name: 'claude-x' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'claude-old' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'claude-y' }));
    expect(screen.getByRole('button', { name: 'claude-y' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await user.click(screen.getByRole('button', { name: /^OpenAI/ }));
    expect(screen.queryByRole('button', { name: 'claude-x' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'gpt-x' })).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByTestId('new-node-add'));
    expect(onAdd).toHaveBeenCalledWith('agent', { providerId: 'p-openai', modelId: 'gpt-x' });
  });

  it('shows the would-be node: preview card, what it does, ports', async () => {
    renderDialog({});
    expect(screen.getByText('Add to · Launch post')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'New node' })).toBeInTheDocument();
    expect(screen.getByText(/give it a goal/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveAttribute('placeholder', 'Agent');
    expect(screen.getByRole('group', { name: 'Provider' })).toBeInTheDocument();
    const ports = screen.getByRole('group', { name: 'Ports' });
    expect(ports).toHaveTextContent('← text');
    expect(ports).toHaveTextContent('→ text');

    await user.type(screen.getByLabelText('Name'), 'Poet');
    expect(document.querySelector('[data-testid^="node-card-"]')).toHaveTextContent('Poet');
  });

  it('focus: the search box on open, Tab stays inside, back to the opener on close', async () => {
    const props: NewNodeDialogProps = {
      workflowId: WF,
      workflowName: 'Launch post',
      open: false,
      onClose: vi.fn(),
      onAdd: vi.fn(),
    };
    const { rerender } = render(
      <>
        <button type="button">New node</button>
        <NewNodeDialog {...props} />
      </>,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const opener = screen.getByRole('button', { name: 'New node' });
    opener.focus();

    rerender(
      <>
        <button type="button">New node</button>
        <NewNodeDialog {...props} open />
      </>,
    );
    const dialog = screen.getByRole('dialog', { name: 'New node' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    const search = screen.getByRole('searchbox', { name: 'Search node types' });
    expect(search).toHaveFocus();

    // Shift+Tab from the first stop wraps to the last (the CTA), Tab wraps back
    await user.tab({ shift: true });
    expect(screen.getByTestId('new-node-add')).toHaveFocus();
    await user.tab();
    expect(search).toHaveFocus();
    // and every stop in between stays inside the window
    for (let i = 0; i < 30; i += 1) {
      await user.tab();
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
    }

    rerender(
      <>
        <button type="button">New node</button>
        <NewNodeDialog {...props} open={false} />
      </>,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });
});
