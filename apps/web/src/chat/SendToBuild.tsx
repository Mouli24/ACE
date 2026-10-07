import type { ChatMessage, Node } from '@ace/contracts';
import { Hammer } from 'lucide-react';
import { useState } from 'react';

import { NewTaskDialog } from '../tasks/NewTaskDialog';
import { useWorkflowGraph, useWorkflows } from '../workflows/hooks';
import { sendToBuildInitial } from './send-to-build';

/**
 * The small *Send to Build* under an agent reply (ACE parity P1): it opens the New task dialog
 * prefilled from the reply, in the project the chat's workflow belongs to, with the chat as the
 * task's source.
 */
export function SendToBuildButton({ node, message }: { node: Node; message: ChatMessage }) {
  const [open, setOpen] = useState(false);
  const graph = useWorkflowGraph(node.workflowId);
  const projectId = graph.data?.workflow.projectId;
  const workflows = useWorkflows(open ? projectId : undefined);

  return (
    <>
      <button
        type="button"
        data-testid={`send-to-build-${message.id}`}
        disabled={projectId === undefined}
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1 rounded-chip px-1.5 py-0.5 font-machine text-[10.5px] text-fg-muted hover:bg-card hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
      >
        <Hammer className="h-3 w-3" aria-hidden /> Send to Build
      </button>
      {open && projectId !== undefined && (
        <NewTaskDialog
          projectId={projectId}
          workflows={workflows.data ?? []}
          initial={sendToBuildInitial(node, message)}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
