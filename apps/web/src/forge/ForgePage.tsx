import { useParams } from 'react-router-dom';

import { useProjectFiles } from './files/project-socket';
import { ForgeWorkbench } from './ForgeWorkbench';

/** The Forge route element (D299). The project's folder is watched while it is mounted. */
export function ForgePage() {
  const { projectId = '' } = useParams();
  useProjectFiles(projectId);
  return <ForgeWorkbench projectId={projectId} />;
}
