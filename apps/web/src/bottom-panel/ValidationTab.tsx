import { Button } from '@ace/ui';
import { CircleX, TriangleAlert } from 'lucide-react';
import { useMutation } from '@tanstack/react-query';

import { api } from '../app/api';
import { useSelectionStore } from '../app/stores/selection';

/** FR-WF-006: run `/validate` and list every issue with severity, message and node reference. */
export function ValidationTab({ workflowId }: { workflowId: string }) {
  const validate = useMutation({ mutationFn: () => api().validateWorkflow(workflowId) });
  const select = useSelectionStore((s) => s.setSelection);
  const issues = validate.data?.issues;

  return (
    <div className="flex flex-col gap-3 py-3">
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
        <ul className="flex flex-col gap-1.5">
          {issues.map((issue, index) => (
            <li
              key={`${issue.code}-${index}`}
              className="flex items-center gap-2.5 rounded-field border border-border bg-card px-3 py-2.5 text-sm"
            >
              {issue.severity === 'error' ? (
                <CircleX className="h-3.5 w-3.5 shrink-0 text-danger" aria-label="error" />
              ) : (
                <TriangleAlert
                  className="h-3.5 w-3.5 shrink-0 text-status-WAITING"
                  aria-label="warning"
                />
              )}
              <span className="flex-1">{issue.message}</span>
              <span className="font-machine text-[9.5px] text-fg-faint">{issue.code}</span>
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
