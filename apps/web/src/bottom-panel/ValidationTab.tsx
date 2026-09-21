import { Button } from '@ace/ui';
import { useMutation } from '@tanstack/react-query';
import { AlertTriangle, CircleX } from 'lucide-react';

import { api } from '../app/api';
import { useSelectionStore } from '../app/stores/selection';

/** FR-WF-006: run `/validate` and list every issue with severity, message and node reference. */
export function ValidationTab({ workflowId }: { workflowId: string }) {
  const validate = useMutation({ mutationFn: () => api().validateWorkflow(workflowId) });
  const select = useSelectionStore((s) => s.setSelection);
  const issues = validate.data?.issues;

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex items-center gap-3">
        <Button
          size="sm"
          variant="secondary"
          onClick={() => validate.mutate()}
          disabled={validate.isPending}
        >
          Validate
        </Button>
        {issues && (
          <span className="text-xs text-fg-muted">
            {issues.length === 0
              ? 'No issues.'
              : `${issues.length} issue${issues.length === 1 ? '' : 's'}`}
          </span>
        )}
        {validate.error && (
          <span role="alert" className="text-xs text-danger">
            {validate.error.message}
          </span>
        )}
      </div>
      {issues && issues.length > 0 && (
        <ul className="flex flex-col gap-1">
          {issues.map((issue, index) => (
            <li key={`${issue.code}-${index}`} className="flex items-start gap-2 text-sm">
              {issue.severity === 'error' ? (
                <CircleX className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-label="error" />
              ) : (
                <AlertTriangle
                  className="mt-0.5 h-4 w-4 shrink-0 text-status-WAITING"
                  aria-label="warning"
                />
              )}
              <span className="font-machine text-xs text-fg-muted">{issue.code}</span>
              <span className="flex-1">{issue.message}</span>
              {issue.nodeId && (
                <button
                  type="button"
                  className="font-machine text-xs text-accent underline-offset-2 hover:underline"
                  onClick={() => select([issue.nodeId as string], [])}
                >
                  show node
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
