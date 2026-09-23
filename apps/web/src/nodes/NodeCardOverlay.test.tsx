import { NODE_STATES, type NodeState } from '@ace/contracts';
import { ReactFlowProvider } from '@xyflow/react';
import { render, screen } from '@testing-library/react';
import { act, type ReactNode } from 'react';

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
  it('renders one label, one icon and one ring colour per state', () => {
    const seen = new Map<NodeState, { label: string; ring: string; icon: string }>();

    for (const state of NODE_STATES) {
      const { unmount } = view({ state });
      const card = screen.getByTestId(/^node-card-/);
      const ring = screen.getByTestId('status-ring');
      const icon = ring.querySelector('svg');
      expect(card).toHaveAttribute('data-state', state);
      seen.set(state, {
        label: ring.getAttribute('aria-label') ?? '',
        ring: (card.getAttribute('style') ?? '').match(/--ring-color: ([^;]+)/)?.[1] ?? '',
        icon: icon?.getAttribute('class') ?? '',
      });
      unmount();
    }

    expect(new Set([...seen.values()].map((v) => v.label)).size).toBe(NODE_STATES.length);
    expect(new Set([...seen.values()].map((v) => v.ring)).size).toBe(NODE_STATES.length);
    // Colour alone would fail a colour-blind reader, so the icon must differ too (NFR-USE-02).
    expect(new Set([...seen.values()].map((v) => v.icon)).size).toBe(NODE_STATES.length);
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

describe('FR-NODE-012 the Output node shows the run’s final output', () => {
  it('replaces the placeholder once the run produced something', () => {
    const node = output();
    const { unmount } = view({ node });
    expect(screen.getByText(/final result appears here after a run/i)).toBeInTheDocument();
    unmount();

    view({ node, state: 'COMPLETED', finalOutput: [{ type: 'text', text: 'the answer' }] });
    expect(screen.getByTestId(`final-output-${node.id}`)).toHaveTextContent('the answer');
  });
});

describe('FR-PRV-005 a node whose provider is gone says so', () => {
  it('shows the "provider missing" badge beside the model chip', () => {
    const node = agent();
    view({ node, providerMissing: true });
    expect(screen.getByTestId(`provider-missing-${node.id}`)).toHaveTextContent('provider missing');
  });
});

describe('TC-EXE-007 streamed text appears on the card as it arrives', () => {
  it('grows with each delta', () => {
    const node = agent();
    const { rerender } = render(
      inFlow(
        <NodeCardView
          node={node}
          state="RUNNING"
          selected={false}
          connectedPortIds={new Set()}
          streamedText="The "
        />,
      ),
    );
    expect(screen.getByText(/^The$/)).toBeInTheDocument();

    rerender(
      inFlow(
        <NodeCardView
          node={node}
          state="RUNNING"
          selected={false}
          connectedPortIds={new Set()}
          streamedText="The quick brown"
        />,
      ),
    );
    expect(screen.getByText('The quick brown')).toBeInTheDocument();
  });

  /**
   * TC-NFR-003 / NFR-PERF-04: the text must be on screen within 200 ms of the frame arriving. The
   * render is synchronous inside `act`, so what this measures is the component's own cost — if a
   * future change made streaming async or throttled, this is the test that would catch it.
   */
  it('paints a delta within 200 ms of receiving it', () => {
    const node = agent();
    const { rerender } = render(
      inFlow(
        <NodeCardView
          node={node}
          state="RUNNING"
          selected={false}
          connectedPortIds={new Set()}
          streamedText=""
        />,
      ),
    );

    const started = performance.now();
    act(() => {
      rerender(
        inFlow(
          <NodeCardView
            node={node}
            state="RUNNING"
            selected={false}
            connectedPortIds={new Set()}
            streamedText="a delta that must be visible"
          />,
        ),
      );
    });
    const painted = performance.now() - started;

    expect(screen.getByText('a delta that must be visible')).toBeInTheDocument();
    expect(painted).toBeLessThan(200);
    // the round file asks for the measurement to appear in the output
    console.info(`TC-NFR-003 paint latency: ${painted.toFixed(1)} ms`);
  });
});
