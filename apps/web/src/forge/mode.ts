import { useMatch } from 'react-router-dom';

/**
 * D299: inside a workflow a person is in Ideate (the canvas) or Forge (the code editor) — or, D303,
 * in Domain (the runs as the team's conversation).
 */
export type WorkflowMode = 'ideate' | 'forge' | 'domain';

/**
 * A mode's path. PG-3.2: `carry` keeps the selected run and the node in focus (`?run=`, `?node=`)
 * across the switch — pass the current search params; anything else in them stays behind, and so
 * does Domain's `?run=new`.
 */
export function workflowPath(
  projectId: string,
  workflowId: string,
  mode: WorkflowMode,
  carry?: URLSearchParams,
): string {
  const base = `/projects/${projectId}/workflows/${workflowId}`;
  const path = mode === 'ideate' ? base : `${base}/${mode}`;
  if (carry === undefined) return path;
  const query = new URLSearchParams();
  const run = carry.get('run');
  if (run !== null && run !== 'new') query.set('run', run);
  const node = carry.get('node');
  if (node !== null) query.set('node', node);
  const text = query.toString();
  return text === '' ? path : `${path}?${text}`;
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
