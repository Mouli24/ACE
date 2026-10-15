import { isAddressableNode, type Node, type NodeState } from '@ace/contracts';
import type { PersistedRunEvent } from '@ace/sdk';
import { useMemo } from 'react';

import { useProject } from '../projects/hooks';
import { useRun } from '../runs/hooks';
import { useRunStore } from '../runs/run-store';
import { agentMap, type AgentLook } from '../theme/agents';
import { useWorkflowGraph } from '../workflows/hooks';

/*
 * Who wrote which file, from the run's own record (D334): every `tool.call` frame of a file-writing
 * tool in the run store. Nothing here is guessed — a file no agent wrote has no attribution, and a
 * write whose text can no longer be found in the buffer shows no line range.
 */

/** ACE's own file tools and the coding CLIs' writes, as their activity is named (D307). */
export const WRITE_TOOLS: ReadonlySet<string> = new Set([
  'write_file',
  'edit_file',
  'cli_write',
  'cli_edit',
  'cli_multi_edit',
  'cli_write_file',
  'cli_replace',
  'cli_file_change',
  'cli_notebook_edit',
]);

type ArgBag = Record<string, unknown>;

const bag = (args: unknown): ArgBag | undefined =>
  typeof args === 'object' && args !== null && !Array.isArray(args) ? (args as ArgBag) : undefined;

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value !== '';

/** The paths a write names: `path`, `file_path`, `notebook_path`, or Codex's `changes[].path`. */
export function writtenPaths(args: unknown): string[] {
  const record = bag(args);
  if (record === undefined) return [];
  const direct = [record['path'], record['file_path'], record['notebook_path']].filter(nonEmpty);
  const changes = Array.isArray(record['changes'])
    ? (record['changes'] as unknown[]).map((change) => bag(change)?.['path']).filter(nonEmpty)
    : [];
  return [...direct, ...changes];
}

const slashes = (path: string): string => path.replace(/\\/g, '/');
const isAbsolute = (path: string): boolean => path.startsWith('/') || /^[A-Za-z]:\//.test(path);
const isDrivePath = (path: string): boolean => /^[A-Za-z]:\//.test(path);

/**
 * A written path as Forge names files: forward slashes, relative to the project folder. An
 * absolute path outside the folder is not one of the project's files (`undefined`).
 */
export function projectPath(raw: string, folderPath: string | undefined): string | undefined {
  const path = slashes(raw.trim());
  if (!isAbsolute(path)) {
    const relative = path.replace(/^(\.\/)+/, '');
    return relative === '' ? undefined : relative;
  }
  if (folderPath === undefined || folderPath === '') return undefined;
  const folder = slashes(folderPath).replace(/\/+$/, '');
  // Windows paths compare without case: `C:/x` and `c:/x` are one folder.
  const fold = isDrivePath(path) ? (s: string) => s.toLowerCase() : (s: string) => s;
  if (!fold(path).startsWith(`${fold(folder)}/`)) return undefined;
  const relative = path.slice(folder.length + 1);
  return relative === '' ? undefined : relative;
}

/**
 * What a write changed: `undefined` when it wrote the whole file (it carries `content`), else the
 * new texts of its edits (`newString`, `new_string`, a MultiEdit's `edits[]`). A Codex
 * `file_change` names only paths, so it has no text to find.
 */
export function editedTexts(args: unknown): string[] | undefined {
  const record = bag(args);
  if (record === undefined) return [];
  if (typeof record['content'] === 'string') return undefined;
  const direct = [record['newString'], record['new_string']].filter(nonEmpty);
  const edits = Array.isArray(record['edits'])
    ? (record['edits'] as unknown[]).flatMap((edit) => {
        const each = bag(edit);
        return [each?.['newString'], each?.['new_string']].filter(nonEmpty);
      })
    : [];
  return [...direct, ...edits];
}

/** The latest write to one file: by whom, when, and what it wrote. */
export interface FileTouch {
  agent: AgentLook;
  /** The node run that wrote it, to name the model it ran on (PG-3.4). */
  nodeRunId: string;
  at: string;
  /** `undefined`: the whole file; otherwise the new texts of the edit (D334). */
  edit: readonly string[] | undefined;
}

export interface ForgeAttribution {
  /** Path → the agent writing it now: its node is RUNNING and wrote the file in this run. */
  live: ReadonlyMap<string, AgentLook>;
  /** Path → the most recent successful write to it in this run. */
  last: ReadonlyMap<string, FileTouch>;
}

export const NO_ATTRIBUTION: ForgeAttribution = { live: new Map(), last: new Map() };

export interface AttributionSources {
  /** The node a node run belongs to (`nodeRunById(id).nodeId`). */
  nodeIdOf(nodeRunId: string): string | undefined;
  nodeState(nodeId: string): NodeState;
  /** The workflow's agents by node id: their name, letter and colour. */
  agents: ReadonlyMap<string, AgentLook>;
  /** The project's folder on disk, to make absolute paths relative. */
  folderPath: string | undefined;
}

/** Fold the run's frames, in order, into who wrote each file last and who is writing it now. */
export function attribute(
  events: readonly PersistedRunEvent[],
  sources: AttributionSources,
): ForgeAttribution {
  const live = new Map<string, AgentLook>();
  const last = new Map<string, FileTouch>();
  for (const event of events) {
    if (event.type !== 'tool.call') continue;
    const { toolCall, nodeRunId } = event.payload;
    // A refused or failed call changed nothing on disk.
    if (!WRITE_TOOLS.has(toolCall.toolName) || toolCall.status !== 'ok') continue;
    const nodeId = sources.nodeIdOf(nodeRunId);
    const agent = nodeId === undefined ? undefined : sources.agents.get(nodeId);
    if (nodeId === undefined || agent === undefined) continue;
    const running = sources.nodeState(nodeId) === 'RUNNING';
    const edit = editedTexts(toolCall.args);
    for (const raw of writtenPaths(toolCall.args)) {
      const path = projectPath(raw, sources.folderPath);
      if (path === undefined) continue;
      last.set(path, { agent, nodeRunId, at: toolCall.at, edit });
      if (running) live.set(path, agent);
    }
  }
  return { live, last };
}

export interface LineSpan {
  from: number;
  to: number;
}

/** The 1-based line of a character offset. */
const lineAt = (text: string, offset: number): number => {
  let line = 1;
  for (let index = text.indexOf('\n'); index !== -1 && index < offset;) {
    line += 1;
    index = text.indexOf('\n', index + 1);
  }
  return line;
};

const newlines = (text: string): number => text.split('\n').length - 1;

/**
 * The lines a write covers in the buffer as it is now: a whole-file write is every line; an edit
 * is where its new text sits (the span of every piece found). Not found anywhere: `undefined`.
 */
export function touchedLines(
  buffer: string,
  edit: readonly string[] | undefined,
): LineSpan | undefined {
  const text = buffer.replace(/\r\n/g, '\n');
  if (edit === undefined) return { from: 1, to: newlines(text) + 1 };
  let span: LineSpan | undefined;
  for (const raw of edit) {
    const piece = raw.replace(/\r\n/g, '\n');
    const at = text.indexOf(piece);
    if (piece === '' || at === -1) continue;
    const from = lineAt(text, at);
    // a trailing newline ends the piece's last line; it does not start another one
    const to = from + newlines(piece.endsWith('\n') ? piece.slice(0, -1) : piece);
    span =
      span === undefined
        ? { from, to }
        : { from: Math.min(span.from, from), to: Math.max(span.to, to) };
  }
  return span;
}

/** PG-3.4: the files a node wrote last in the run — what Forge marks while that node is followed. */
export function filesWrittenBy(
  attribution: ForgeAttribution,
  nodeId: string | undefined,
): ReadonlySet<string> {
  const paths = new Set<string>();
  if (nodeId === undefined) return paths;
  for (const [path, touch] of attribution.last) if (touch.agent.nodeId === nodeId) paths.add(path);
  return paths;
}

const modelOfNode = (nodes: readonly Node[] | undefined, nodeId: string): string | undefined => {
  const node = nodes?.find((each) => each.id === nodeId);
  return node !== undefined && isAddressableNode(node) ? node.config.modelId : undefined;
};

/**
 * PG-3.4: the model a node ran on — what its node run reports it used (the resolved model when the
 * provider names one), else the run's snapshot of the node, else the node as configured now.
 */
export function useNodeModel(
  workflowId: string | undefined,
  nodeId: string | undefined,
  nodeRunId?: string,
): string | undefined {
  const used = useRunStore((store) => {
    if (nodeId === undefined || workflowId === undefined || store.workflowId !== workflowId) {
      return undefined;
    }
    const nodeRun =
      (nodeRunId === undefined ? undefined : store.nodeRunById(nodeRunId)) ?? store.nodeRun(nodeId);
    return nodeRun?.modelUsed?.resolvedModelId ?? nodeRun?.modelUsed?.modelId;
  });
  const runId = useRunStore((store) =>
    workflowId !== undefined && store.workflowId === workflowId ? store.runId : undefined,
  );
  const snapshot = useRun(used === undefined ? runId : undefined).data?.snapshot.nodes;
  const graph = useWorkflowGraph(workflowId).data?.nodes;
  if (nodeId === undefined) return undefined;
  return used ?? modelOfNode(snapshot, nodeId) ?? modelOfNode(graph, nodeId);
}

/**
 * The run's file attribution for Forge, live (D334). It recomputes when a persisted frame arrives —
 * a tool call or a node state — never per streamed token, and only for this workflow's run.
 */
export function useForgeAttribution(
  projectId: string,
  workflowId: string | undefined,
): ForgeAttribution {
  const folderPath = useProject(projectId).data?.folderPath;
  const nodes = useWorkflowGraph(workflowId).data?.nodes;
  // `run:frames` — a string, so the selector is stable between persisted frames
  const revision = useRunStore((store) => {
    if (workflowId === undefined || store.workflowId !== workflowId) return '';
    const frames = store.events().length;
    return frames === 0 ? '' : `${store.runId ?? ''}:${frames}`;
  });
  return useMemo(() => {
    if (revision === '' || nodes === undefined) return NO_ATTRIBUTION;
    const store = useRunStore.getState();
    return attribute(store.events(), {
      nodeIdOf: (nodeRunId) => store.nodeRunById(nodeRunId)?.nodeId,
      nodeState: (nodeId) => store.nodeState(nodeId),
      agents: agentMap(nodes),
      folderPath,
    });
  }, [revision, nodes, folderPath]);
}
