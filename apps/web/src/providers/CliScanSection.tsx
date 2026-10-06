import type { CliDetection, CliProviderType } from '@ace/contracts';
import { Button } from '@ace/ui';
import { useState } from 'react';

import { useCliScan } from './hooks';
import { PROVIDER_TYPE_LABEL } from './provider-meta';

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
    <span className="inline-flex items-center gap-1">
      <code className="font-machine text-xs">{text}</code>
      <Button type="button" variant="ghost" size="sm" aria-label={`Copy ${text}`} onClick={() => void copy()}>
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </span>
  );
}

function ScanRow({ cli, onAdd }: { cli: CliDetection; onAdd: (type: CliProviderType) => void }) {
  const label = PROVIDER_TYPE_LABEL[cli.type];
  const version = cli.version === undefined ? '' : `v${cli.version} · `;
  const detail = cli.loginDetail === undefined ? '' : ` (${cli.loginDetail})`;

  return (
    <li data-testid={`cli-scan-${cli.type}`} className="flex flex-wrap items-center gap-2 text-sm">
      <span className="w-28 shrink-0 font-human">{label}</span>
      {!cli.installed ? (
        <>
          <span className="text-fg-muted">not installed — install with</span>
          <Command text={cli.installHint} />
        </>
      ) : cli.login === 'logged_out' ? (
        <>
          <span className="text-fg-muted">{version}not signed in — run</span>
          <Command text={cli.loginHint} />
          <span className="text-fg-muted">in a terminal, then scan again</span>
        </>
      ) : (
        <>
          <span className="flex-1">
            {version}
            {cli.login === 'logged_in' ? 'signed in' : 'sign-in not verified'}
            {detail}
          </span>
          <Button type="button" size="sm" variant="secondary" aria-label={`Add ${label}`} onClick={() => onAdd(cli.type)}>
            Add
          </Button>
        </>
      )}
    </li>
  );
}

/**
 * "Found in your terminal" (X1, FR-PRV-008): the coding-agent CLIs on the engine's machine. One that
 * is installed and signed in is one click from being a provider; the others say what to run.
 */
export function CliScanSection({ onAdd }: { onAdd: (type: CliProviderType) => void }) {
  const scan = useCliScan();

  return (
    <section
      aria-labelledby="cli-scan-title"
      data-testid="cli-scan"
      className="flex flex-col gap-2 rounded-card border border-border bg-card px-3 py-3"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 id="cli-scan-title" className="text-sm font-semibold">
          Found in your terminal
        </h3>
        <Button type="button" variant="ghost" size="sm" disabled={scan.isFetching} onClick={() => void scan.refetch()}>
          {scan.isFetching ? 'Scanning…' : 'Scan again'}
        </Button>
      </div>
      {scan.isPending && <p className="text-sm text-fg-muted">Scanning your terminal…</p>}
      {scan.isError && (
        <p role="alert" className="text-sm text-danger">
          Could not scan: {scan.error.message}
        </p>
      )}
      {scan.data !== undefined && (
        <ul className="flex flex-col gap-1.5">
          {scan.data.items.map((cli) => (
            <ScanRow key={cli.type} cli={cli} onAdd={onAdd} />
          ))}
        </ul>
      )}
    </section>
  );
}
