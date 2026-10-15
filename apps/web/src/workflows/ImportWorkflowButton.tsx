import { FORMAT_VERSION, WorkflowExportSchema } from '@ace/contracts';
import { toast } from '@ace/ui';
import { useId, useRef, type ChangeEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

import { MODE_LABEL, MODES } from '../app/ModeLinks';
import { workflowPath } from '../forge/mode';
import { useImportWorkflow } from './hooks';

/** `Blob.text()` is missing in some environments; FileReader is everywhere. */
function readText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsText(file);
  });
}

/**
 * FR-WF-008 (UI side): pick a `.ace.json` export, check its format version, send it to
 * `POST /projects/:id/workflows/import`, open the new workflow. `input` is the hidden file input to
 * render, `pick()` opens it, and every failure goes to `onError` in words. The project page's
 * "Import JSON" and the workspace menu's "Import workflow…" (D331) both use it.
 */
export function useWorkflowImport(
  projectId: string,
  {
    onError,
    onStart,
    label = 'Import JSON',
  }: {
    onError: (message: string) => void;
    /** A file was chosen: clear the last error. */
    onStart?: () => void;
    /** The hidden input's accessible name. */
    label?: string;
  },
): { input: ReactNode; pick: () => void; pending: boolean } {
  const id = useId();
  const ref = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const importWorkflow = useImportWorkflow(projectId);

  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    onStart?.();
    let raw: unknown;
    try {
      raw = JSON.parse(await readText(file));
    } catch {
      onError(`“${file.name}” is not valid JSON.`);
      return;
    }
    const version = (raw as { formatVersion?: unknown } | null)?.formatVersion;
    if (version !== FORMAT_VERSION) {
      onError(
        `Unsupported format version ${String(version)}; this ACE reads version ${FORMAT_VERSION}.`,
      );
      return;
    }
    const parsed = WorkflowExportSchema.safeParse(raw);
    if (!parsed.success) {
      onError(
        `“${file.name}” is not a workflow export: ${parsed.error.issues[0]?.message ?? 'invalid'}.`,
      );
      return;
    }
    importWorkflow.mutate(parsed.data, {
      onSuccess: (graph) => {
        const workflowId = graph.workflow.id;
        navigate(workflowPath(projectId, workflowId, 'ideate'));
        // PG-3.7: the imported workflow opens in Ideate, and every mode is offered with it.
        toast.success(`Imported “${graph.workflow.name}”`, {
          description: (
            <span className="flex gap-[6px] pt-1" data-testid="import-mode-links">
              {MODES.map((mode) => (
                <button
                  key={mode}
                  type="button"
                  data-testid={`import-open-${mode}`}
                  onClick={() => navigate(workflowPath(projectId, workflowId, mode))}
                  className="inline-flex h-[24px] cursor-pointer items-center rounded-full border border-[var(--line)] bg-[var(--chip)] px-[10px] text-[11px] font-semibold text-[var(--ink)] hover:bg-[var(--hover)]"
                >
                  {MODE_LABEL[mode]}
                </button>
              ))}
            </span>
          ),
        });
      },
      onError: (e) => onError(e.message),
    });
  };

  const input = (
    <input
      ref={ref}
      id={id}
      type="file"
      accept=".json,application/json"
      className="sr-only"
      tabIndex={-1}
      aria-label={label}
      onChange={(e) => void onFile(e)}
    />
  );
  return { input, pick: () => ref.current?.click(), pending: importWorkflow.isPending };
}
