import { useParams } from 'react-router-dom';

import { useIsCompact } from '../responsive/useIsCompact';
import { RunApprovalsDock } from '../runs/approvals/RunApprovalsDock';
import { useRunStore } from '../runs/run-store';
import { CompactForge } from './CompactForge';
import { useProjectFiles } from './files/project-socket';
import { ForgeWorkbench } from './ForgeWorkbench';
import { useProcessEvents } from './terminal/process-events';

/** The Forge route element (D299). The project's folder is watched while it is mounted; a phone browses only. */
export function ForgePage() {
  const { projectId = '', workflowId } = useParams();
  useProjectFiles(projectId);
  // D301: process frames reach their tabs while Forge is open; entering re-attaches each tab.
  useProcessEvents(projectId);
  // PG-3.5: the workflow's run as the workspace holds it — its approvals are answered here too.
  const runId = useRunStore((store) =>
    workflowId !== undefined && store.workflowId === workflowId ? store.runId : undefined,
  );
  const compact = useIsCompact();
  return (
    <>
      {compact ? (
        <CompactForge projectId={projectId} />
      ) : (
        <ForgeWorkbench projectId={projectId} workflowId={workflowId} />
      )}
      <RunApprovalsDock runId={runId} floating />
    </>
  );
}
