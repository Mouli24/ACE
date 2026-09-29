import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';

import { TimelineFilters } from './TimelineFilters';
import type { TimelineFilter } from './timeline-messages';

const NODE_A = 'node-a';
const NODE_B = 'node-b';
const RUN_A = 'run-a';

/** A controlled harness, so a click on one filter keeps the other filters set (combinable). */
function Harness({ onFilter }: { onFilter?: (filter: TimelineFilter) => void }) {
  const [filter, setFilter] = useState<TimelineFilter>({});
  return (
    <TimelineFilters
      filter={filter}
      onChange={(next) => {
        setFilter(next);
        onFilter?.(next);
      }}
      runIds={[RUN_A]}
      nodeIds={[NODE_A, NODE_B]}
      nodeName={(id) => (id === NODE_A ? 'Writer' : 'Reviewer')}
    />
  );
}

describe('TimelineFilters (FR-CHAT-002)', () => {
  it('combines a node and a type into one filter', async () => {
    const user = userEvent.setup();
    const onFilter = vi.fn<(filter: TimelineFilter) => void>();
    render(<Harness onFilter={onFilter} />);

    await user.click(screen.getByLabelText('Filter by node'));
    await user.click(await screen.findByRole('option', { name: 'Reviewer' }));
    expect(onFilter).toHaveBeenLastCalledWith({ nodeId: NODE_B });

    await user.click(screen.getByLabelText('Filter by type'));
    await user.click(await screen.findByRole('option', { name: 'error' }));
    // The node stays set — the two filters intersect (FR-CHAT-002).
    expect(onFilter).toHaveBeenLastCalledWith({ nodeId: NODE_B, type: 'error' });
  });

  it('shows Clear only once a filter is set, and clears everything', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    expect(screen.queryByTestId('timeline-clear-filters')).not.toBeInTheDocument();

    await user.click(screen.getByLabelText('Filter by run'));
    await user.click(await screen.findByRole('option', { name: 'run 1' }));

    const clear = screen.getByTestId('timeline-clear-filters');
    await user.click(clear);
    expect(screen.queryByTestId('timeline-clear-filters')).not.toBeInTheDocument();
  });
});
