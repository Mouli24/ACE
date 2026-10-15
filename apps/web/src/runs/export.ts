import { api } from '../app/api';

/**
 * PG-5.5 (FR-BEN-005): fetch the run's judging bundle — record, node runs, outputs, event log — and
 * hand it to the browser as a file. `anonymise` asks the engine to strip node names, providers and
 * models for blind judging. No secret is in either form (the engine masks them).
 */
export async function downloadRunExport(
  runId: string,
  options: { anonymise?: boolean } = {},
): Promise<void> {
  const anonymise = options.anonymise === true;
  const bundle = await api().exportRun(runId, { anonymise });
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `run-${runId}${anonymise ? '-anonymised' : ''}.ace-run.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
