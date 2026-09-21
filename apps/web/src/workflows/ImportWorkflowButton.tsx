import { FORMAT_VERSION, WorkflowExportSchema } from '@ace/contracts';
import { Button } from '@ace/ui';
import { Upload } from 'lucide-react';
import { useId, useRef, useState, type ChangeEvent } from 'react';
import { useNavigate } from 'react-router-dom';

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
 * `POST /projects/:id/workflows/import`, open the new workflow. Errors stay inline.
 */
export function ImportWorkflowButton({ projectId }: { projectId: string }) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const importWorkflow = useImportWorkflow(projectId);
  const [error, setError] = useState<string>();

  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setError(undefined);
    let raw: unknown;
    try {
      raw = JSON.parse(await readText(file));
    } catch {
      setError(`“${file.name}” is not valid JSON.`);
      return;
    }
    const version = (raw as { formatVersion?: unknown } | null)?.formatVersion;
    if (version !== FORMAT_VERSION) {
      setError(
        `Unsupported format version ${String(version)}; this ACE reads version ${FORMAT_VERSION}.`,
      );
      return;
    }
    const parsed = WorkflowExportSchema.safeParse(raw);
    if (!parsed.success) {
      setError(
        `“${file.name}” is not a workflow export: ${parsed.error.issues[0]?.message ?? 'invalid'}.`,
      );
      return;
    }
    importWorkflow.mutate(parsed.data, {
      onSuccess: (graph) => navigate(`/projects/${projectId}/workflows/${graph.workflow.id}`),
      onError: (e) => setError(e.message),
    });
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <input
        ref={input}
        id={id}
        type="file"
        accept=".json,application/json"
        className="sr-only"
        aria-label="Import JSON"
        onChange={(e) => void onFile(e)}
      />
      <Button
        variant="secondary"
        onClick={() => input.current?.click()}
        disabled={importWorkflow.isPending}
      >
        <Upload className="h-4 w-4" /> Import JSON
      </Button>
      {error && (
        <p role="alert" className="max-w-sm text-right text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
