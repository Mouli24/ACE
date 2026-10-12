import { useParams } from 'react-router-dom';

import { useIsCompact } from '../responsive/useIsCompact';
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
  return useIsCompact() ? (
    <CompactForge projectId={projectId} />
  ) : (
    <ForgeWorkbench projectId={projectId} workflowId={workflowId} />
  );
}
