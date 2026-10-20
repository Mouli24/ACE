import type { NodeRun } from '@ace/contracts';
import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';

import { openFile } from './editor/actions';
import { workflowPath } from './mode';

/**
 * The project files an agentic node's step changed (D378): its workspace summary's files, else the
 * paths its tool calls recorded as changed (`ToolCall.changedPaths`). Paths stay as recorded —
 * workspace-relative with forward slashes.
 */
export function stepFilesOf(
  nodeRun: Pick<NodeRun, 'workspace' | 'toolCalls'> | undefined,
): string[] {
  if (nodeRun === undefined) return [];
  const summary = nodeRun.workspace?.filesChanged.map((file) => file.path) ?? [];
  if (summary.length > 0) return summary;
  const paths = new Set<string>();
  for (const call of nodeRun.toolCalls) {
    if (call.status !== 'ok') continue;
    for (const path of call.changedPaths ?? []) paths.add(path);
  }
  return [...paths];
}

/**
 * Open files in Forge the way a run's Result card does: each in its own tab, then Forge on the
 * run (`?run=`). Needs a router around it.
 */
export function useOpenInForge(
  projectId: string | undefined,
  workflowId: string | undefined,
): (paths: readonly string[], runId?: string) => void {
  const navigate = useNavigate();
  return useCallback(
    (paths, runId) => {
      if (projectId === undefined || workflowId === undefined) return;
      for (const path of paths) openFile(projectId, path, { preview: false });
      const base = workflowPath(projectId, workflowId, 'forge');
      navigate(runId === undefined ? base : `${base}?run=${encodeURIComponent(runId)}`);
    },
    [navigate, projectId, workflowId],
  );
}
