import { cn } from '@ace/ui';
import { useMemo } from 'react';

import { parseUnifiedDiff, type DiffLineKind } from './diff';

const ROW: Readonly<Record<DiffLineKind, string>> = {
  meta: 'text-fg-muted',
  hunk: 'bg-[color-mix(in_oklab,var(--color-status-READY)_10%,transparent)] text-[var(--color-status-READY)]',
  add: 'bg-[color-mix(in_oklab,var(--color-status-COMPLETED)_13%,transparent)] text-fg',
  del: 'bg-[color-mix(in_oklab,var(--color-status-FAILED)_13%,transparent)] text-fg',
  context: 'text-fg-soft',
  note: 'text-fg-muted italic',
};

const SIGN: Readonly<Record<DiffLineKind, string>> = {
  meta: '',
  hunk: '',
  add: '+',
  del: '−',
  context: '',
  note: '',
};

const SIGN_COLOR: Partial<Record<DiffLineKind, string>> = {
  add: 'text-[var(--color-status-COMPLETED)]',
  del: 'text-[var(--color-status-FAILED)]',
};

/**
 * One file's unified diff (ACE parity P0, design §8 Changes): old and new line numbers, a sign
 * column, and added/removed lines tinted green/red — the sign is printed too, so colour is never
 * the only way to tell them apart. React text only: a patch can never become markup.
 */
export function DiffView({
  path,
  patch,
  binary = false,
  truncated = false,
}: {
  path: string;
  patch: string;
  binary?: boolean;
  truncated?: boolean;
}) {
  const lines = useMemo(() => parseUnifiedDiff(patch), [patch]);
  if (binary) {
    return (
      <p data-testid="diff-binary" className="font-human text-sm text-fg-muted">
        {path} is a binary file: there is no text diff to show.
      </p>
    );
  }
  return (
    <div
      role="region"
      aria-label={`Diff of ${path}`}
      data-testid="diff-view"
      className="overflow-x-auto rounded-field border border-border bg-sunken"
    >
      <table className="w-full border-collapse font-machine text-[11.5px] leading-[1.65]">
        <tbody>
          {lines.map((line, index) => (
            <tr key={index} data-kind={line.kind} className={ROW[line.kind]}>
              <td className="w-10 select-none border-r border-border px-2 text-right text-fg-faint">
                {line.oldNumber ?? ''}
              </td>
              <td className="w-10 select-none border-r border-border px-2 text-right text-fg-faint">
                {line.newNumber ?? ''}
              </td>
              <td
                aria-hidden={SIGN[line.kind] === '' ? true : undefined}
                className={cn('w-5 select-none text-center', SIGN_COLOR[line.kind])}
              >
                {SIGN[line.kind]}
              </td>
              <td className="whitespace-pre pr-4">{line.text}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {truncated && (
        <p className="border-t border-border px-3 py-2 font-human text-xs text-fg-muted">
          The diff is too long to show whole; this is its beginning.
        </p>
      )}
    </div>
  );
}
