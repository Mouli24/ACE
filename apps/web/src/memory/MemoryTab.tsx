import type { Id } from '@ace/contracts';

/** The right pane's Memory tab: the focused agent's long-term memory (FR-MEM-004). Stub; filled by M5 wave 1. */
export function MemoryTab(_props: { workflowId: Id }) {
  return <p className="p-3 text-sm text-fg-muted">Select an agent to see its memory.</p>;
}
