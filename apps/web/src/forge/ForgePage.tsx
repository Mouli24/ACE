import { useEffect } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';

import { useIsCompact } from '../responsive/useIsCompact';
import { RunApprovalsDock } from '../runs/approvals/RunApprovalsDock';
import { useSelectedRun } from '../runs/selected-run';
import { useChangesStore } from './changes/changes-store';
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
  // PG-3.5: the workflow's one selected run (PG-3.2) — its approvals are answered here too.
  const { runId } = useSelectedRun(workflowId);
  const compact = useIsCompact();
  // PG-5.1: a run's page links here with `?checkpoint=`: Changes opens on that checkpoint.
  const [search] = useSearchParams();
  const checkpoint = search.get('checkpoint') ?? undefined;
  useEffect(() => {
    if (projectId !== '' && checkpoint !== undefined) {
      useChangesStore.getState().show(projectId, checkpoint);
    }
  }, [projectId, checkpoint]);
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
