import { useParams } from 'react-router-dom';

import { useIsCompact } from '../responsive/useIsCompact';
import { CompactForge } from './CompactForge';
import { useProjectFiles } from './files/project-socket';
import { ForgeWorkbench } from './ForgeWorkbench';

/** The Forge route element (D299). The project's folder is watched while it is mounted; a phone browses only. */
export function ForgePage() {
  const { projectId = '', workflowId } = useParams();
  useProjectFiles(projectId);
  return useIsCompact() ? (
    <CompactForge projectId={projectId} />
  ) : (
    <ForgeWorkbench projectId={projectId} workflowId={workflowId} />
  );
}
