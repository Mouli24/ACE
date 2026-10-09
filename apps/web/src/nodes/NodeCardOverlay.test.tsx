import { NODE_STATES, type NodeState } from '@ace/contracts';
import { ReactFlowProvider } from '@xyflow/react';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

import { createNode } from './factory';
import { NodeCardView } from './NodeCard';

const agent = () => createNode('agent', '01WF00000000000000000000000', { x: 0, y: 0 });
const output = () => createNode('output', '01WF00000000000000000000000', { x: 0, y: 0 });

/** Port handles are React Flow components, so even the pure card needs its provider. */
const inFlow = (ui: ReactNode) => <ReactFlowProvider>{ui}</ReactFlowProvider>;

const view = (props: Partial<Parameters<typeof NodeCardView>[0]> = {}) => {
  const node = props.node ?? agent();
  return render(
    inFlow(
      <NodeCardView
        node={node}
        state="IDLE"
        selected={false}
        connectedPortIds={new Set()}
        {...props}
      />,
    ),
  );
};

describe('TC-EXE-008 every node state is visually distinct', () => {
  it('renders one label, one printed word and one chip colour per state', () => {
    const seen = new Map<NodeState, { label: string; colour: string; word: string }>();

    for (const state of NODE_STATES) {
      const { unmount } = view({ state });
      const card = screen.getByTestId(/^node-card-/);
      const chip = screen.getByTestId('status-chip');
      expect(card).toHaveAttribute('data-state', state);
      expect(chip).toHaveAttribute('data-state', state);
      seen.set(state, {
        label: chip.getAttribute('aria-label') ?? '',
        colour: chip.style.color,
        word: chip.textContent ?? '',
      });
      unmount();
    }

    expect(new Set([...seen.values()].map((v) => v.label)).size).toBe(NODE_STATES.length);
    expect(new Set([...seen.values()].map((v) => v.colour)).size).toBe(NODE_STATES.length);
    // Colour alone would fail a colour-blind reader, so the state is printed as a word too
    // (NFR-USE-02) — the chip's visible text differs for every state.
    expect(new Set([...seen.values()].map((v) => v.word)).size).toBe(NODE_STATES.length);
    expect([...seen.values()].every((v) => v.word.trim() !== '')).toBe(true);
  });
});

describe('TC-NODE-009 the provider accent never moves with the state', () => {
  it('keeps one accent colour across all nine states', () => {
    const accents = new Set<string>();
    for (const state of NODE_STATES) {
      const { unmount } = view({ state, provider: 'anthropic' });
      const style = screen.getByTestId(/^node-card-/).getAttribute('style') ?? '';
      accents.add(style.match(/--accent-color: ([^;]+)/)?.[1] ?? '');
      unmount();
    }
    expect(accents.size).toBe(1);
  });

  it('gives two providers two different accents', () => {
    const { unmount } = view({ provider: 'anthropic' });
    const first = screen.getByTestId(/^node-card-/).getAttribute('style');
    unmount();
    view({ provider: 'openai' });
    expect(screen.getByTestId(/^node-card-/).getAttribute('style')).not.toEqual(first);
  });
});

describe('TC-RTR-004 the card says which model answered', () => {
  it('names the model, and marks it when the router fell back', () => {
    const node = agent();
    const { unmount } = view({
      node,
      state: 'COMPLETED',
      modelUsed: {
        providerId: '01P000000000000000000000000',
        modelId: 'mock-text',
        viaFallback: false,
      },
    });
    expect(screen.getByTestId(`used-model-${node.id}`)).toHaveTextContent('used: mock-text');
    expect(screen.getByTestId(`used-model-${node.id}`)).not.toHaveTextContent('fallback');
    unmount();

    view({
      node,
      state: 'COMPLETED',
      modelUsed: {
        providerId: '01P000000000000000000000000',
        modelId: 'mock-text-fallback',
        viaFallback: true,
      },
    });
    expect(screen.getByTestId(`used-model-${node.id}`)).toHaveTextContent(
      'used: mock-text-fallback (fallback)',
    );
  });
});

describe('D285 a card never shows a run’s output — that is read in the chat', () => {
  it('an Output node points to where its result is, and never prints it', () => {
    const node = output();
    view({ node, state: 'COMPLETED' });
    expect(screen.getByText(/read it in Inspect/i)).toBeInTheDocument();
    expect(screen.queryByTestId(`final-output-${node.id}`)).toBeNull();
  });

  it('an Agent shows its goal, or asks for one', () => {
    const blank = agent();
    const { unmount } = view({ node: blank });
    expect(screen.getByText(/no goal yet/i)).toBeInTheDocument();
    unmount();

    const base = agent();
    const goal = { ...base, config: { ...base.config, instructions: 'Write a haiku about rain.' } };
    view({ node: goal as typeof base });
    expect(screen.getByTestId(`node-goal-${goal.id}`)).toHaveTextContent(
      'Write a haiku about rain.',
    );
  });
});

describe('FR-PRV-005 a node whose provider is gone says so', () => {
  it('shows the "provider missing" badge beside the model chip', () => {
    const node = agent();
    view({ node, providerMissing: true });
    expect(screen.getByTestId(`provider-missing-${node.id}`)).toHaveTextContent('provider missing');
  });
});

describe('D285 a running node says so, and its stream goes to the chat, not the card', () => {
  it('shows "running — answer in Chat" while it runs, beside its goal', () => {
    const base = agent();
    const node = {
      ...base,
      config: { ...base.config, instructions: 'Write a haiku.' },
    } as typeof base;
    view({ node, state: 'RUNNING' });
    expect(screen.getByTestId(`running-note-${node.id}`)).toHaveTextContent(
      'running — answer in Chat',
    );
    expect(screen.getByTestId(`node-goal-${node.id}`)).toHaveTextContent('Write a haiku.');
  });
});
