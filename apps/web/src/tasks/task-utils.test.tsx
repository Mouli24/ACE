import type { TaskCheck } from '@ace/contracts';
import { render, screen } from '@testing-library/react';

import { headChecksFailed, splitChecks } from './checks';
import { parseUnifiedDiff } from './diff';
import { DiffView } from './DiffView';
import { parseLabels, shortSha, timeAgo } from './meta';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

const check = (
  id: string,
  name: string,
  status: TaskCheck['status'],
  headSha: string,
  at: string,
) =>
  ({
    id: `01ARZ3NDEKTSV4RRFFQ69G5F${id}`,
    taskId: '01ARZ3NDEKTSV4RRFFQ69G5FT0',
    name,
    command: `run ${name}`,
    status,
    output: '',
    durationMs: 10,
    headSha,
    at,
  }) satisfies TaskCheck;

describe('ACE-P0 checks of a head (design §5)', () => {
  const checks = [
    check('C1', 'test', 'failed', A, '2026-10-06T10:00:00.000Z'),
    check('C2', 'lint', 'passed', A, '2026-10-06T10:00:01.000Z'),
    check('C3', 'test', 'passed', A, '2026-10-06T10:05:00.000Z'),
    check('C4', 'test', 'failed', B, '2026-10-06T09:00:00.000Z'),
  ];

  it('keeps the latest result per name for the head, everything else is older', () => {
    const { headSha, latest, older } = splitChecks(checks, A);
    expect(headSha).toBe(A);
    expect(latest.map((c) => `${c.name}:${c.status}`)).toEqual(['test:passed', 'lint:passed']);
    expect(older.map((c) => c.id.slice(-2))).toEqual(['C1', 'C4']);
    expect(headChecksFailed(checks, A)).toBe(false);
    expect(headChecksFailed(checks, B)).toBe(true);
  });

  it('without a head, the newest commit any check ran on stands in', () => {
    expect(splitChecks(checks, undefined).headSha).toBe(A);
    expect(splitChecks([], undefined)).toEqual({ headSha: undefined, latest: [], older: [] });
  });
});

describe('ACE-P0 unified diff parsing', () => {
  it('numbers old and new lines from the hunk headers and keeps the kinds apart', () => {
    const lines = parseUnifiedDiff(
      [
        'diff --git a/x.ts b/x.ts',
        'index 1..2 100644',
        '--- a/x.ts',
        '+++ b/x.ts',
        '@@ -3,3 +3,3 @@ export',
        ' keep',
        '--- a line that was "-- a line"',
        '+new',
        '\\ No newline at end of file',
        '',
      ].join('\n'),
    );
    expect(lines.map((line) => line.kind)).toEqual([
      'meta',
      'meta',
      'meta',
      'meta',
      'hunk',
      'context',
      'del',
      'add',
      'note',
    ]);
    expect(lines[5]).toMatchObject({ text: 'keep', oldNumber: 3, newNumber: 3 });
    expect(lines[6]).toMatchObject({ text: '-- a line that was "-- a line"', oldNumber: 4 });
    expect(lines[7]).toMatchObject({ text: 'new', newNumber: 4 });
  });

  it('DiffView says when a file is binary or the diff was cut short', () => {
    const { rerender } = render(<DiffView path="logo.png" patch="" binary />);
    expect(screen.getByTestId('diff-binary')).toHaveTextContent('logo.png is a binary file');
    rerender(<DiffView path="big.ts" patch={'@@ -1 +1 @@\n-a\n+b\n'} truncated />);
    expect(screen.getByRole('region', { name: 'Diff of big.ts' })).toHaveTextContent(
      'too long to show whole',
    );
  });
});

describe('ACE-P0 task wording helpers', () => {
  it('parses comma-separated labels: trimmed, no blanks or repeats', () => {
    expect(parseLabels(' search, ui ,, search ,')).toEqual(['search', 'ui']);
    expect(parseLabels('')).toEqual([]);
    expect(parseLabels(Array.from({ length: 12 }, (_, i) => `l${i}`).join(','))).toHaveLength(10);
  });

  it('shortens a sha and says how long ago', () => {
    expect(shortSha(A)).toBe('aaaaaaa');
    const now = Date.parse('2026-10-06T12:00:00.000Z');
    expect(timeAgo('2026-10-06T11:59:50.000Z', now)).toBe('just now');
    expect(timeAgo('2026-10-06T11:55:00.000Z', now)).toBe('5 min ago');
    expect(timeAgo('2026-10-06T09:00:00.000Z', now)).toBe('3 h ago');
    expect(timeAgo('2026-10-04T12:00:00.000Z', now)).toBe('2 d ago');
  });
});
