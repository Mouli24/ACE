import { Button } from '@ace/ui';
import { useMutation } from '@tanstack/react-query';

import { api } from '../app/api';
import { showNode } from '../canvas/canvas-api';

/**
 * FR-WF-006: run `/validate` and list every issue with severity, message and node reference.
 *
 * In the theme (D328): Validate is the Close pill; each issue is a 36px row in one surface card,
 * hairlines between, with its severity as a ✕ (red) or ! (accent) glyph, the code in mono and
 * "show node" in the link colour.
 */
export function ValidationTab({ workflowId }: { workflowId: string }) {
  const validate = useMutation({ mutationFn: () => api().validateWorkflow(workflowId) });
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
          <span className="text-[12px] text-[var(--muted)]">
            {issues.length === 0
              ? 'No issues.'
              : `${issues.length} issue${issues.length === 1 ? '' : 's'}`}
          </span>
        )}
        {validate.error && (
          <span role="alert" className="text-[12px] text-danger">
            {validate.error.message}
          </span>
        )}
      </div>
      {issues && issues.length > 0 && (
        <ul className="m-0 flex list-none flex-col overflow-hidden rounded-[12px] border border-[var(--line)] bg-[var(--surface)] p-0">
          {issues.map((issue, index) => (
            <li
              key={`${issue.code}-${index}`}
              className="flex min-h-[36px] items-center gap-[10px] border-t border-[var(--line)] px-[14px] py-[7px] text-[12.5px] first:border-t-0"
            >
              {issue.severity === 'error' ? (
                <span
                  role="img"
                  aria-label="error"
                  className="w-[12px] shrink-0 text-center text-[11px] text-danger"
                >
                  ✕
                </span>
              ) : (
                <span
                  role="img"
                  aria-label="warning"
                  className="w-[12px] shrink-0 text-center text-[12px] font-bold text-[#e8572e]"
                >
                  !
                </span>
              )}
              <span className="min-w-0 flex-1">{issue.message}</span>
              <span className="font-machine text-[9.5px] text-[var(--muted)]">{issue.code}</span>
              {issue.nodeId && (
                <button
                  type="button"
                  className="shrink-0 cursor-pointer border-none bg-transparent p-0 text-[11.5px] font-semibold text-[#e8623a] outline-none hover:text-danger focus-visible:shadow-[0_0_0_2px_var(--focus)]"
                  // [audit W-10] select it and bring it into view
                  onClick={() => showNode(issue.nodeId as string)}
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
