import { NODE_STATES, type NodeState } from '@ace/contracts';
import { ReactFlowProvider } from '@xyflow/react';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

import { createNode } from './factory';
import { NodeCardNotes, NodeCardView } from './NodeCard';

const agent = () => createNode('agent', '01WF00000000000000000000000', { x: 0, y: 0 });

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
        stage={1}
        {...props}
      />,
    ),
  );
};

describe('TC-EXE-008 every node state reads apart on the stage card', () => {
  it('prints one word per state (NFR-USE-02: never colour alone)', () => {
    const seen = new Map<NodeState, string>();
    for (const state of NODE_STATES) {
      const { unmount } = view({ state });
      expect(screen.getByTestId(/^node-card-/)).toHaveAttribute('data-state', state);
      const status = screen.getByTestId('status-chip');
      expect(status).toHaveAttribute('data-state', state);
      seen.set(state, status.textContent ?? '');
      unmount();
    }
    // D328: the theme gives several states the same grey dot, so the word is what tells them apart.
    expect(new Set(seen.values()).size).toBe(NODE_STATES.length);
    expect([...seen.values()].every((word) => word.trim() !== '')).toBe(true);
  });
});

describe('TC-NODE-009 the provider look never moves with the state', () => {
  it('keeps one border and one orb across all nine states', () => {
    const looks = new Set<string>();
    for (const state of NODE_STATES) {
      const { unmount } = view({ state, provider: 'anthropic' });
      const card = screen.getByTestId(/^node-card-/);
      const orb = screen.getByTestId(/^stage-orb-/);
      looks.add(`${card.style.border}|${orb.style.background}`);
      unmount();
    }
    expect(looks.size).toBe(1);
  });

  it('gives two providers two different looks', () => {
    const { unmount } = view({ provider: 'anthropic' });
    const first = screen.getByTestId(/^stage-orb-/).style.background;
    unmount();
    view({ provider: 'openai' });
    expect(screen.getByTestId(/^stage-orb-/).style.background).not.toEqual(first);
  });
});

describe('TC-RTR-004 the notes say which model answered', () => {
  it('names the model when it is not the configured one, and marks a fallback', () => {
    const node = agent();
    const { unmount } = render(
      <NodeCardNotes
        node={node}
        state="COMPLETED"
        modelUsed={{
          providerId: '01P000000000000000000000000',
          modelId: 'mock-text',
          viaFallback: false,
        }}
      />,
    );
    expect(screen.getByTestId(`used-model-${node.id}`)).toHaveTextContent('used: mock-text');
    expect(screen.getByTestId(`used-model-${node.id}`)).not.toHaveTextContent('fallback');
    unmount();

    render(
      <NodeCardNotes
        node={node}
        state="COMPLETED"
        modelUsed={{
          providerId: '01P000000000000000000000000',
          modelId: 'mock-text-fallback',
          viaFallback: true,
        }}
      />,
    );
    expect(screen.getByTestId(`used-model-${node.id}`)).toHaveTextContent(
      'used: mock-text-fallback (fallback)',
    );
  });

  it('says nothing when the configured model answered — the sub line already names it', () => {
    const base = agent();
    const node = { ...base, config: { ...base.config, modelId: 'mock-text' } } as typeof base;
    render(
      <NodeCardNotes
        node={node}
        state="COMPLETED"
        modelUsed={{
          providerId: '01P000000000000000000000000',
          modelId: 'mock-text',
          viaFallback: false,
        }}
      />,
    );
    expect(screen.queryByTestId(`used-model-${node.id}`)).toBeNull();
  });
});

describe('D285 a card never shows a run’s output — that is read in the chat', () => {
  it('an Output node prints no result', () => {
    const node = createNode('output', '01WF00000000000000000000000', { x: 0, y: 0 });
    view({ node, state: 'COMPLETED' });
    expect(screen.queryByTestId(`final-output-${node.id}`)).toBeNull();
    expect(screen.getByTestId(`node-meta-${node.id}`)).toHaveTextContent('OUTPUT');
  });
});
