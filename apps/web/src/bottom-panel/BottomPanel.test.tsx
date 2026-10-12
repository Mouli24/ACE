import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

import { usePanelsStore } from '../app/stores/panels';
import { useRunStore } from '../runs/run-store';
import { BottomPanel } from './BottomPanel';

const nodeRunRows = vi.hoisted(() => ({
  rows: [] as { id: string; nodeId: string; status: string; attempt: number }[],
}));

vi.mock('../runs/hooks', () => ({
  useNodeRuns: () => ({ data: nodeRunRows.rows }),
  useRetryNodeRun: () => ({ mutate: vi.fn(), isPending: false, variables: undefined }),
}));
vi.mock('../workflows/hooks', () => ({ useWorkflowGraph: () => ({ data: undefined }) }));
vi.mock('../providers/hooks', () => ({ useProviders: () => ({ data: [] }) }));

function renderPanel() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <BottomPanel workflowId="W1" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('BottomPanel (theme v2)', () => {
  beforeEach(() => {
    nodeRunRows.rows = [];
    act(() => {
      usePanelsStore.setState({ bottomOpen: true, bottomTab: 'validation' });
      useRunStore.getState().arm('W1');
      useRunStore.getState().begin('W1', 'R1', 'RUNNING');
    });
  });

  it('renders only the tab row, no tabpanel, when collapsed', () => {
    act(() => usePanelsStore.setState({ bottomOpen: false }));
    renderPanel();
    expect(screen.getAllByRole('tab')).toHaveLength(4);
    expect(screen.queryByRole('tabpanel')).not.toBeInTheDocument();
  });

  it('the ✕ ("Close problems & events") closes it and a tab click re-opens it', async () => {
    const user = userEvent.setup();
    renderPanel();
    expect(screen.getByRole('tabpanel')).toBeInTheDocument();
    const close = screen.getByRole('button', { name: 'Close problems & events' });
    expect(close).toBe(screen.getByTestId('bottom-toggle'));
    expect(close).toHaveTextContent('✕');
    await user.click(close);
    expect(usePanelsStore.getState().bottomOpen).toBe(false);
    expect(screen.queryByRole('tabpanel')).not.toBeInTheDocument();
    // nothing left to close, so no close button
    expect(
      screen.queryByRole('button', { name: 'Close problems & events' }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Errors' }));
    expect(usePanelsStore.getState().bottomOpen).toBe(true);
  });

  it('the Errors count is FAILED node runs only; stopped or blocked runs show none', () => {
    nodeRunRows.rows = [
      { id: 'a', nodeId: 'n1', status: 'FAILED', attempt: 1 },
      { id: 'b', nodeId: 'n2', status: 'BLOCKED', attempt: 1 },
      { id: 'c', nodeId: 'n3', status: 'STOPPED', attempt: 1 },
      { id: 'd', nodeId: 'n4', status: 'COMPLETED', attempt: 1 },
    ];
    const first = renderPanel();
    expect(screen.getByRole('tab', { name: 'Errors 1' })).toBeInTheDocument();
    expect(screen.getByTestId('bottom-count-errors')).toHaveTextContent('1');
    first.unmount();

    nodeRunRows.rows = [{ id: 'c', nodeId: 'n3', status: 'STOPPED', attempt: 1 }];
    const second = renderPanel();
    expect(screen.queryByTestId('bottom-count-errors')).not.toBeInTheDocument();
    second.unmount();

    nodeRunRows.rows = [{ id: 'b', nodeId: 'n2', status: 'BLOCKED', attempt: 1 }];
    renderPanel();
    expect(screen.queryByTestId('bottom-count-errors')).not.toBeInTheDocument();
  });

  it('the close button sits outside the tablist, as the theme 28px ✕', () => {
    renderPanel();
    const close = screen.getByTestId('bottom-toggle');
    expect(close).toHaveClass('h-7', 'w-7', 'rounded-[7px]');
    const tablist = screen.getByRole('tablist');
    expect(within(tablist).queryAllByRole('button')).toHaveLength(0);
    expect(tablist).not.toContainElement(close);
  });

  it('the tabs are the kit segmented pill (D328), the active one inked', () => {
    renderPanel();
    const active = screen.getByRole('tab', { name: 'Validation' });
    expect(active).toHaveAttribute('data-state', 'active');
    expect(active.className).toContain('data-[state=active]:bg-[var(--seg)]');
    expect(screen.getByRole('tablist')).toHaveClass('rounded-full', 'bg-[var(--soft)]');
  });
});
