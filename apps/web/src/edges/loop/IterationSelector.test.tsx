import { NodeRunSchema, zeroUsage, type NodeRun } from '@ace/contracts';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { IterationSelector, outputPreview } from './IterationSelector';

/** A ULID the contract accepts, spelled from a tag so each fixture id stays readable. */
const ulid = (tag: string) =>
  `01J${tag.replace(/[^0-9A-HJKMNP-TV-Z]/g, 'X')}`.padEnd(26, 'Z').slice(0, 26);

/** Parsed through the contract, so a shape the engine could not send can never pass this test. */
function nodeRun(over: Partial<NodeRun> & Pick<NodeRun, 'iteration'>): NodeRun {
  return NodeRunSchema.parse({
    id: ulid(`NR${over.iteration}A${over.attempt ?? 1}`),
    runId: ulid('RUN1'),
    nodeId: ulid('WRITER'),
    attempt: 1,
    status: 'COMPLETED',
    inputEnvelopes: [],
    usage: zeroUsage(),
    verdicts: [],
    toolCalls: [],
    ...over,
  });
}

const iterations: NodeRun[] = [
  nodeRun({ iteration: 1, output: [{ type: 'text', text: 'A first draft of the letter.' }] }),
  nodeRun({ iteration: 2, output: [{ type: 'text', text: 'A tighter second draft.' }] }),
  nodeRun({
    iteration: 3,
    output: [{ type: 'text', text: 'The final draft.' }],
    loopStop: 'exit_condition',
  }),
];

describe('TC-PAR-006 Iteration history', () => {
  it('lists every iteration with its number and a preview of its output', () => {
    render(<IterationSelector runs={iterations} onSelect={vi.fn()} />);
    expect(screen.getByTestId('iteration-selector')).toHaveTextContent('3 iterations');
    for (const run of iterations) {
      const row = screen.getByTestId(`iteration-option-${run.iteration}`);
      expect(row).toHaveTextContent(`iteration ${run.iteration}`);
      expect(row).toHaveTextContent(outputPreview(run.output));
    }
  });

  it('reports the iteration the user picks', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<IterationSelector runs={iterations} onSelect={onSelect} />);

    await user.click(screen.getByTestId('iteration-option-2'));
    expect(onSelect).toHaveBeenCalledWith(ulid('NR2A1'));

    await user.click(screen.getByTestId('iteration-option-3'));
    expect(onSelect).toHaveBeenCalledWith(ulid('NR3A1'));
    expect(onSelect).toHaveBeenCalledTimes(2);
  });

  it('marks the chosen iteration for a screen reader as well as the eye', () => {
    render(
      <IterationSelector runs={iterations} selectedNodeRunId={ulid('NR2A1')} onSelect={vi.fn()} />,
    );
    expect(screen.getByTestId('iteration-option-2')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('iteration-option-1')).toHaveAttribute('aria-checked', 'false');
  });

  it('says why the loop stopped on the iteration that stopped it', () => {
    render(<IterationSelector runs={iterations} onSelect={vi.fn()} />);
    expect(screen.getByTestId('iteration-option-3')).toHaveTextContent('exit condition met');
    expect(screen.getByTestId('iteration-option-1')).not.toHaveTextContent('exit condition');
  });

  it('orders by iteration, and keeps a retried attempt beside its first try', () => {
    const retried = [
      nodeRun({ iteration: 2, attempt: 2, output: [{ type: 'text', text: 'second try' }] }),
      nodeRun({ iteration: 1, output: [{ type: 'text', text: 'first' }] }),
      nodeRun({ iteration: 2, attempt: 1, status: 'FAILED' }),
    ];
    render(<IterationSelector runs={retried} onSelect={vi.fn()} />);
    const rows = screen.getAllByRole('radio').map((row) => row.textContent ?? '');
    expect(rows[0]).toContain('iteration 1');
    expect(rows[1]).toContain('iteration 2');
    expect(rows[2]).toContain('attempt 2');
    expect(screen.getByTestId('iteration-selector')).toHaveTextContent('2 iterations');
  });

  it('says so when nothing has been recorded yet', () => {
    render(<IterationSelector runs={[]} onSelect={vi.fn()} />);
    expect(screen.getByTestId('iteration-selector-empty')).toHaveTextContent(
      'No iterations recorded.',
    );
  });
});

describe('FR-PAR-005 output preview', () => {
  it('previews each part kind without ever showing bytes', () => {
    expect(outputPreview([{ type: 'text', text: '  spread   out  ' }])).toBe('spread out');
    expect(outputPreview([{ type: 'json', value: { verdict: 'approved' } }])).toBe(
      '{"verdict":"approved"}',
    );
    expect(outputPreview([{ type: 'code', language: 'ts', text: 'const a = 1;' }])).toBe(
      'const a = 1;',
    );
    expect(
      outputPreview([
        { type: 'image', artifactId: 'a1', mime: 'image/png', name: 'chart.png', size: 12 },
      ]),
    ).toBe('image chart.png');
  });

  it('truncates a long output and says so with an ellipsis', () => {
    const preview = outputPreview([{ type: 'text', text: 'x'.repeat(200) }]);
    expect(preview).toHaveLength(73);
    expect(preview.endsWith('…')).toBe(true);
  });

  it('says "no output" rather than an empty row', () => {
    expect(outputPreview(undefined)).toBe('no output');
    expect(outputPreview([])).toBe('no output');
    expect(outputPreview([{ type: 'text', text: '   ' }])).toBe('no output');
  });
});
