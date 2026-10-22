import { useCallback, useEffect, useRef } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';

import { workflowPath, type WorkflowMode } from '../forge/mode';
import { useSelectedRun } from '../runs/selected-run';
import { useSelectionStore } from './stores/selection';

/*
 * PG-3.4 — follow a node anywhere. The node in focus is one thing in all three modes: `?node=` in
 * the URL and `useSelectionStore`'s focused node, kept in step by `useNodeFocusSync` (mounted once,
 * by the workflow layout). Ideate selects it and centres the view on it, Domain opens its lens and
 * marks its roster card, Forge names it and marks the files it wrote.
 */

/**
 * A mode's path with `nodeId` in focus and the selected run carried (`?run=`, `?node=`). `runId`
 * names the run when the URL does not (the default selection), so the other mode lands on it too.
 */
export function nodePath(
  projectId: string,
  workflowId: string,
  mode: WorkflowMode,
  nodeId: string,
  carry: URLSearchParams,
  runId?: string,
): string {
  const query = new URLSearchParams(carry);
  query.set('node', nodeId);
  const run = query.get('run');
  if ((run === null || run === 'new') && runId !== undefined) query.set('run', runId);
  return workflowPath(projectId, workflowId, mode, query);
}

/**
 * Go to `nodeId` in another mode: Ideate selects and centres it, Domain opens its lens, Forge
 * marks what it wrote. The selected run goes along. Needs a workflow route around it.
 */
export function useFollowNode(where?: {
  projectId?: string | undefined;
  workflowId?: string | undefined;
}): (nodeId: string, mode: WorkflowMode) => void {
  const params = useParams();
  // outside a workflow route (a run's page) the caller names the workflow and its project
  const projectId = params['projectId'] ?? where?.projectId ?? '';
  const workflowId = where?.workflowId ?? params['workflowId'] ?? '';
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const { runId } = useSelectedRun(workflowId);
  // a run's page names its run in the path, not the query
  const runInPath = params['runId'];
  return useCallback(
    (nodeId, mode) => {
      useSelectionStore.getState().setSelection([nodeId], []);
      navigate(nodePath(projectId, workflowId, mode, nodeId, search, runInPath ?? runId));
    },
    [projectId, workflowId, search, runId, runInPath, navigate],
  );
}

/**
 * Keep `?node=` and the selection store's focused node in step (PG-3.4). The URL wins on arrival
 * and whenever it changes (a link, a mode switch, Domain's lens): the store follows it. In Ideate,
 * where a person selects on the Canvas, the store's focused node is written back to the URL
 * (replacing the entry, so selecting does not fill the history), and selecting nothing — or
 * several nodes — takes `?node=` away.
 */
export function useNodeFocusSync(mode: WorkflowMode | undefined): void {
  const [search, setSearch] = useSearchParams();
  const urlNode = search.get('node') ?? undefined;
  const focused = useSelectionStore((s) => s.focusedNodeId);
  // `null`: not run yet, so the first pass counts as the URL arriving.
  const seenUrl = useRef<string | undefined | null>(null);
  const seenFocus = useRef(focused);
  /**
   * The `?node=` this hook last wrote, until the URL shows it. That change is the store's own echo,
   * not the URL speaking: the store may have moved on since (React Flow reports "nothing selected"
   * for a moment while a Canvas mounts, then the node is selected again), so it is not applied back.
   */
  const written = useRef<{ node: string | undefined } | null>(null);

  useEffect(() => {
    const urlChanged = seenUrl.current !== urlNode;
    const focusChanged = seenFocus.current !== focused;
    seenUrl.current = urlNode;
    seenFocus.current = focused;
    const echo = urlChanged && written.current !== null && written.current.node === urlNode;
    if (echo) written.current = null;
    if (urlChanged && !echo) {
      written.current = null;
      if (urlNode !== undefined && focused !== urlNode) {
        useSelectionStore.getState().setSelection([urlNode], []);
      } else if (urlNode === undefined && focused !== undefined) {
        // no node in the URL (Domain's "All", a link without one): no node in focus either
        useSelectionStore.getState().clear();
      }
      return;
    }
    if (!(focusChanged || echo) || mode !== 'ideate' || focused === urlNode) return;
    written.current = { node: focused };
    setSearch(
      (current) => {
        const query = new URLSearchParams(current);
        if (focused === undefined) query.delete('node');
        else query.set('node', focused);
        return query;
      },
      { replace: true },
    );
  }, [urlNode, focused, mode, setSearch]);
}
