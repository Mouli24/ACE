import { useMatch } from 'react-router-dom';

/** D299: inside a workflow a person is in Ideate (the canvas) or Forge (the code editor). */
export type WorkflowMode = 'ideate' | 'forge';

export function workflowPath(projectId: string, workflowId: string, mode: WorkflowMode): string {
  const base = `/projects/${projectId}/workflows/${workflowId}`;
  return mode === 'forge' ? `${base}/forge` : base;
}

/** `undefined` on a workflow's other routes (the timeline): in neither mode. */
export function useWorkflowMode(): WorkflowMode | undefined {
  const ideate = useMatch('/projects/:projectId/workflows/:workflowId');
  const forge = useMatch('/projects/:projectId/workflows/:workflowId/forge');
  if (forge !== null) return 'forge';
  return ideate === null ? undefined : 'ideate';
}
