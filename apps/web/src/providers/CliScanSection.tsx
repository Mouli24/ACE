import type { CliDetection, CliProviderType } from '@ace/contracts';
import { Button, FIELD_LABEL_CLASS } from '@ace/ui';
import { useState } from 'react';

import { ProviderMark } from './ProviderMark';
import { useCliScan } from './hooks';
import { PROVIDER_TYPE_LABEL } from './provider-meta';

/**
 * The theme's small in-field button (the API key's Show/Hide): 26px, radius 7, hairline, canvas,
 * muted 11px 600.
 */
const SMALL_BUTTON =
  'h-[26px] shrink-0 cursor-pointer rounded-[7px] border border-[var(--line)] bg-[var(--canvas)] px-[10px] text-[11px] font-semibold text-[var(--muted)] outline-none hover:bg-[var(--hover)] focus-visible:border-[var(--focus)] disabled:cursor-not-allowed disabled:opacity-50';

/** A command the user runs in their own terminal, with a copy button (FR-PRV-008's hint). */
function Command({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // No clipboard (an insecure context, a test): the command is still on screen to copy.
    }
  };
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <code className="min-w-0 break-all rounded-[7px] border border-[var(--line)] bg-[var(--canvas)] px-2 py-[3px] font-machine text-[11px]">
        {text}
      </code>
      <button
        type="button"
        className={SMALL_BUTTON}
        aria-label={`Copy ${text}`}
        onClick={() => void copy()}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </span>
  );
}

function ScanRow({ cli, onAdd }: { cli: CliDetection; onAdd: (type: CliProviderType) => void }) {
  const label = PROVIDER_TYPE_LABEL[cli.type];
  const version = cli.version === undefined ? '' : `v${cli.version} · `;
  const detail = cli.loginDetail === undefined ? '' : ` (${cli.loginDetail})`;

  return (
    <li
      data-testid={`cli-scan-${cli.type}`}
      className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[12px]"
    >
      <span className="flex w-32 shrink-0 items-center gap-2">
        <ProviderMark type={cli.type} />
        <span className="text-[12.5px] font-semibold">{label}</span>
      </span>
      {!cli.installed ? (
        <>
          <span className="text-[var(--muted)]">not installed — install with</span>
          <Command text={cli.installHint} />
        </>
      ) : cli.login === 'logged_out' ? (
        <>
          <span className="text-[var(--muted)]">{version}not signed in — run</span>
          <Command text={cli.loginHint} />
          <span className="text-[var(--muted)]">in a terminal, then scan again</span>
        </>
      ) : (
        <>
          <span className="min-w-0 flex-1 text-[var(--muted)]">
            {version}
            {cli.login === 'logged_in' ? 'signed in' : 'sign-in not verified'}
            {detail}
          </span>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            aria-label={`Add ${label}`}
            onClick={() => onAdd(cli.type)}
          >
            Add
          </Button>
        </>
      )}
    </li>
  );
}

/**
 * "Found in your terminal" (X1, FR-PRV-008): the coding-agent CLIs on the engine's machine. One that
 * is installed and signed in is one click from being a provider; the others say what to run. A
 * theme inner box (soft, hairline, radius 10) with a small-caps label.
 */
export function CliScanSection({ onAdd }: { onAdd: (type: CliProviderType) => void }) {
  const scan = useCliScan();

  return (
    <section
      aria-labelledby="cli-scan-title"
      data-testid="cli-scan"
      className="flex flex-col gap-[10px] rounded-[10px] border border-[var(--line)] bg-[var(--soft)] p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 id="cli-scan-title" className={FIELD_LABEL_CLASS}>
          Found in your terminal
        </h3>
        <button
          type="button"
          className={SMALL_BUTTON}
          disabled={scan.isFetching}
          onClick={() => void scan.refetch()}
        >
          {scan.isFetching ? 'Scanning…' : 'Scan again'}
        </button>
      </div>
      {scan.isPending && <p className="text-[12px] text-[var(--muted)]">Scanning your terminal…</p>}
      {scan.isError && (
        <p role="alert" className="text-[12px] text-danger">
          Could not scan: {scan.error.message}
        </p>
      )}
      {scan.data !== undefined && (
        <ul className="flex flex-col gap-2">
          {scan.data.items.map((cli) => (
            <ScanRow key={cli.type} cli={cli} onAdd={onAdd} />
          ))}
        </ul>
      )}
    </section>
  );
}
