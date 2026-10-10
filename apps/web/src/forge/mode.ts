import { useMatch } from 'react-router-dom';

/**
 * D299: inside a workflow a person is in Ideate (the canvas) or Forge (the code editor) — or, D303,
 * in Domain (the runs as the team's conversation).
 */
export type WorkflowMode = 'ideate' | 'forge' | 'domain';

export function workflowPath(projectId: string, workflowId: string, mode: WorkflowMode): string {
  const base = `/projects/${projectId}/workflows/${workflowId}`;
  return mode === 'ideate' ? base : `${base}/${mode}`;
}

/** `undefined` on a workflow's other routes (the timeline): in no mode. */
export function useWorkflowMode(): WorkflowMode | undefined {
  const ideate = useMatch('/projects/:projectId/workflows/:workflowId');
  const forge = useMatch('/projects/:projectId/workflows/:workflowId/forge');
  const domain = useMatch('/projects/:projectId/workflows/:workflowId/domain');
  if (forge !== null) return 'forge';
  if (domain !== null) return 'domain';
  return ideate === null ? undefined : 'ideate';
}
