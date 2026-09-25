import { MERGE_MODES } from '@ace/contracts';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { MergeModeField } from './MergeModeField';
import { MergeSlots, type MergeSlot } from './MergeSlots';

const slots: MergeSlot[] = [
  {
    portId: 'merge:in:in',
    portName: 'in',
    fromNodeId: '01JWRITERZZZZZZZZZZZZZZZZZ',
    fromNodeName: 'Writer',
  },
  {
    portId: 'merge:in:in_json',
    portName: 'in_json',
    fromNodeId: '01JREVIEWERZZZZZZZZZZZZZZZ',
    fromNodeName: 'Reviewer',
  },
];

describe('FR-PAR-002 merge mode', () => {
  it('offers exactly the contract’s modes', () => {
    render(<MergeModeField value="all" onChange={vi.fn()} />);
    expect(screen.getByLabelText(/mode/i)).toHaveTextContent('all');
    expect(MERGE_MODES).toEqual(['all', 'any']);
  });

  it('reports the mode the user picks', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<MergeModeField value="all" onChange={onChange} />);
    await user.click(screen.getByLabelText(/mode/i));
    await user.click(await screen.findByRole('option', { name: /^any$/i }));
    expect(onChange).toHaveBeenCalledWith('any');
  });

  it('says what each mode does, so "any" is not a guess', () => {
    render(<MergeModeField value="any" onChange={vi.fn()} />);
    expect(screen.getByText(/all: wait for every input/)).toHaveTextContent(
      'any: continue on the first',
    );
  });
});

describe('FR-PAR-002 merge slots', () => {
  it('shows one row per connected input, labelled with the feeding node', () => {
    render(<MergeSlots slots={slots} mode="all" />);
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[0] as HTMLElement).getByText('Writer')).toBeInTheDocument();
    expect(within(rows[0] as HTMLElement).getByText('in')).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText('Reviewer')).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText('in_json')).toBeInTheDocument();
  });

  it('keeps the rows in port order, which is the order the output lists them in', () => {
    render(<MergeSlots slots={[...slots].reverse()} mode="all" />);
    const names = screen.getAllByRole('listitem').map((row) => row.textContent ?? '');
    expect(names[0]).toContain('Reviewer');
    expect(names[1]).toContain('Writer');
  });

  it('says which branch arrived first during a run', () => {
    const arrived: MergeSlot[] = [
      { ...(slots[0] as MergeSlot), arrivedAt: '2026-09-26T10:00:02.000Z' },
      { ...(slots[1] as MergeSlot), arrivedAt: '2026-09-26T10:00:01.000Z' },
    ];
    render(<MergeSlots slots={arrived} mode="all" />);
    expect(screen.getByTestId('merge-slot-in_json')).toHaveAttribute('data-arrival', '1');
    expect(screen.getByTestId('merge-slot-in_json')).toHaveTextContent('1st to arrive');
    expect(screen.getByTestId('merge-slot-in')).toHaveAttribute('data-arrival', '2');
    expect(screen.getByTestId('merge-slot-in')).toHaveTextContent('2nd to arrive');
  });

  it('shows a branch that has not arrived as waiting', () => {
    const half: MergeSlot[] = [
      { ...(slots[0] as MergeSlot), arrivedAt: '2026-09-26T10:00:01.000Z' },
      slots[1] as MergeSlot,
    ];
    render(<MergeSlots slots={half} mode="all" />);
    expect(screen.getByTestId('merge-slot-in')).toHaveTextContent('1st to arrive');
    expect(screen.getByTestId('merge-slot-in_json')).toHaveAttribute('data-arrival', 'waiting');
    expect(screen.getByTestId('merge-slot-in_json')).toHaveTextContent('waiting');
    expect(screen.getByTestId('merge-slots')).toHaveTextContent('Waits for every input');
  });

  it('in any mode, only the first arrival feeds the merge — the rest are recorded', () => {
    const arrived: MergeSlot[] = [
      { ...(slots[0] as MergeSlot), arrivedAt: '2026-09-26T10:00:01.000Z' },
      { ...(slots[1] as MergeSlot), arrivedAt: '2026-09-26T10:00:05.000Z' },
    ];
    render(<MergeSlots slots={arrived} mode="any" />);
    expect(screen.getByTestId('merge-slot-in')).not.toHaveTextContent('recorded only');
    expect(screen.getByTestId('merge-slot-in_json')).toHaveTextContent('recorded only');
    expect(screen.getByTestId('merge-slots')).toHaveTextContent(
      'Continues on the first to arrive; the rest still run and are recorded.',
    );
  });

  it('says so when nothing is connected', () => {
    render(<MergeSlots slots={[]} mode="all" />);
    expect(screen.getByTestId('merge-slots-empty')).toHaveTextContent(
      'Nothing is connected to this merge yet.',
    );
  });
});
