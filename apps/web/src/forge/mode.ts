import { useMatch } from 'react-router-dom';

/** D299: inside a workflow a person is in Ideate (the canvas) or Forge (the code editor). */
export type WorkflowMode = 'ideate' | 'forge';

export function workflowPath(projectId: string, workflowId: string, mode: WorkflowMode): string {
  const base = `/projects/${projectId}/workflows/${workflowId}`;
  return mode === 'forge' ? `${base}/forge` : base;
}

export function useWorkflowMode(): WorkflowMode {
  return useMatch('/projects/:projectId/workflows/:workflowId/forge') === null ? 'ideate' : 'forge';
}
