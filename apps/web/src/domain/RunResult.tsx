import type { Node, NodeRun, Part, Run } from '@ace/contracts';
import { Button, cn, Icons, PartRenderer, toast } from '@ace/ui';
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';

import { api } from '../app/api';
import { projectPath, WRITE_TOOLS, writtenPaths } from '../forge/attribution';
import { openFile } from '../forge/editor/actions';
import { workflowPath } from '../forge/mode';
import { useProject } from '../projects/hooks';
import { useRestartRun } from '../runs/hooks';
import { isLiveRun } from '../runs/selected-run';
import { haltWords } from './looks';

/**
 * The end of a run's conversation, said plainly (`@workflow`): what the run produced — each Output
 * node's output, or with no Output node its finish line's (D285), through the part renderers — and
 * every file its nodes wrote, each openable in Forge. A HALTED or BLOCKED run shows the same above
 * why it stopped, in words, with Retry (a restart, when the engine allows one), so a run that did
 * its work never looks empty. Domain's projection ends with a one-line "Run COMPLETE." and never
 * shows an Output node's parts, so this card is the result, not a copy of a message above it.
 * Nothing while the run is live.
 */
export function RunResult({
  run,
  nodeRuns,
  onRestarted,
  className,
}: {
  run: Run;
  nodeRuns?: readonly NodeRun[];
  /** The restart made a new run: the caller selects it. */
  onRestarted?: (run: Run) => void;
  className?: string;
}) {
  const restart = useRestartRun();
  const navigate = useNavigate();
  const folderPath = useProject(run.projectId).data?.folderPath;
  const files = useMemo(
    () => filesWrittenIn(run, nodeRuns, folderPath),
    [run, nodeRuns, folderPath],
  );
  if (isLiveRun(run)) return null;

  const canRestart = (run.allowedActions ?? []).includes('restart');
  const retry = canRestart ? (
    <Button
      type="button"
      size="sm"
      variant="secondary"
      data-testid="run-result-retry"
      disabled={restart.isPending}
      onClick={() =>
        restart.mutate(run.id, {
          onSuccess: (next) => onRestarted?.(next),
          onError: (error) => toast.error(error.message),
        })
      }
    >
      <Icons.RotateCcw aria-hidden size={13} />
      Retry
    </Button>
  ) : null;

  const openInForge = (paths: readonly string[]) => {
    for (const path of paths) openFile(run.projectId, path, { preview: false });
    navigate(
      `${workflowPath(run.projectId, run.workflowId, 'forge')}?run=${encodeURIComponent(run.id)}`,
    );
  };

  // A run blocked at pre-flight never started: nothing was produced.
  const started = run.status !== 'BLOCKED' || (nodeRuns ?? []).length > 0;
  const outputs = started ? producedOutputs(run, nodeRuns) : [];
  const written = started ? files : [];
  const produced = (
    <>
      {outputs.map(({ node, parts }) => (
        <div
          key={node.id}
          data-testid={`run-result-output-${node.id}`}
          className="flex min-w-0 flex-col gap-2 overflow-x-auto break-words border-t border-[var(--line)] px-[14px] py-[11px] first-of-type:border-t-0"
        >
          <span className="text-[11px] font-semibold text-[var(--muted)]">{node.name}</span>
          {parts.map((part, index) => (
            <PartRenderer
              key={index}
              part={part}
              contentUrl={(artifactId) => api().artifactContentUrl(artifactId)}
            />
          ))}
        </div>
      ))}
      {written.length > 0 && <FilesWritten files={written} onOpen={openInForge} />}
    </>
  );

  if (run.status === 'COMPLETE') {
    return (
      <section
        data-testid="run-result"
        data-status="COMPLETE"
        aria-label="Result"
        className={cn(
          'flex min-w-0 flex-col overflow-hidden rounded-[12px] border border-[rgba(47,158,99,0.35)] bg-[var(--surface)]',
          className,
        )}
      >
        <h3 className="m-0 flex items-center gap-2 border-b border-[rgba(47,158,99,0.25)] bg-[rgba(47,158,99,0.10)] px-[14px] py-[10px] text-[13px] font-bold">
          <span aria-hidden className="h-[7px] w-[7px] shrink-0 rounded-full bg-[#2f9e63]" />
          Result
        </h3>
        {outputs.length === 0 && written.length === 0 ? (
          <p className="m-0 px-[14px] py-[11px] text-[12.5px] text-[var(--muted)]">
            The run completed, but its last nodes produced nothing.
          </p>
        ) : (
          produced
        )}
      </section>
    );
  }

  const reasons = failureLines(run, nodeRuns);
  const title =
    run.status === 'BLOCKED'
      ? started
        ? 'The run was blocked'
        : 'Pre-flight blocked this run — nothing was sent to a provider'
      : `The run halted — ${haltWords(run.haltReason ?? 'failure')}`;
  const didWork = outputs.length > 0 || written.length > 0;
  return (
    <section
      data-testid="run-result"
      data-status={run.status}
      aria-label="Result"
      className={cn(
        'flex min-w-0 flex-col overflow-hidden rounded-[12px] border border-[rgba(201,76,39,0.35)] bg-[var(--surface)]',
        className,
      )}
    >
      {didWork && (
        <>
          <h3 className="m-0 flex items-center gap-2 border-b border-[var(--line)] px-[14px] py-[10px] text-[13px] font-bold">
            <span aria-hidden className="h-[7px] w-[7px] shrink-0 rounded-full bg-[#2f9e63]" />
            What the run produced
          </h3>
          {produced}
        </>
      )}
      <div
        role="alert"
        className={cn(
          'flex min-w-0 flex-col gap-2 px-[14px] py-[11px]',
          didWork && 'border-t border-[rgba(201,76,39,0.35)]',
        )}
      >
        <h3 className="m-0 flex items-center gap-2 text-[13px] font-bold">
          <span aria-hidden className="h-[7px] w-[7px] shrink-0 rounded-full bg-[#c94c27]" />
          {title}
        </h3>
        {reasons.length > 0 && (
          <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-[12.5px]">
            {reasons.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ul>
        )}
        {retry !== null && <div className="flex">{retry}</div>}
      </div>
    </section>
  );
}

/** One file the run wrote, and the names of the nodes that wrote it, in order. */
interface WrittenFile {
  path: string;
  by: string[];
}

function FilesWritten({
  files,
  onOpen,
}: {
  files: readonly WrittenFile[];
  onOpen: (paths: readonly string[]) => void;
}) {
  return (
    <div
      data-testid="run-result-files"
      className="flex min-w-0 flex-col gap-1.5 border-t border-[var(--line)] px-[14px] py-[11px] first-of-type:border-t-0"
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 text-[11px] font-semibold text-[var(--muted)]">
          Files written
        </span>
        {files.length > 1 && (
          <button
            type="button"
            data-testid="run-result-open-all"
            onClick={() => onOpen(files.map((file) => file.path))}
            className="shrink-0 text-[11px] font-semibold text-[#e8623a] hover:text-[#c94c27]"
          >
            Open all in Forge
          </button>
        )}
      </div>
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {files.map((file) => (
          <li
            key={file.path}
            data-testid="run-result-file"
            className="flex min-w-0 items-center gap-2 text-[12.5px]"
          >
            <Icons.FileText aria-hidden size={13} className="shrink-0 text-[var(--muted)]" />
            <span className="min-w-0 truncate font-mono text-[12px]" title={file.path}>
              {file.path}
            </span>
            <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--muted)]">
              {file.by.join(', ')}
            </span>
            <button
              type="button"
              data-testid="run-result-open-file"
              onClick={() => onOpen([file.path])}
              className="shrink-0 text-[11px] font-semibold text-[#e8623a] hover:text-[#c94c27]"
            >
              Open in Forge
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * What the run produced, node by node: its Output nodes' output, or — with no Output node — the
 * output of its finish line, the nodes no data edge leaves (D285). Nodes with nothing are left out.
 */
function producedOutputs(
  run: Run,
  nodeRuns: readonly NodeRun[] | undefined,
): { node: Node; parts: Part[] }[] {
  const { nodes, edges } = run.snapshot;
  const outputNodes = nodes.filter((node) => node.kind === 'output');
  const feeds = new Set(
    edges.filter((edge) => edge.kind === 'data').map((edge) => edge.from.nodeId),
  );
  const last = outputNodes.length > 0 ? outputNodes : nodes.filter((node) => !feeds.has(node.id));
  return last
    .map((node) => ({ node, parts: outputOf(run, nodeRuns, node.id) }))
    .filter((each) => each.parts.length > 0);
}

/**
 * Every file a node of the run wrote, project-relative, in the order first written: the node
 * runs' successful calls of a file-writing tool (`WRITE_TOOLS`, D334).
 */
function filesWrittenIn(
  run: Run,
  nodeRuns: readonly NodeRun[] | undefined,
  folderPath: string | undefined,
): WrittenFile[] {
  const names = new Map(run.snapshot.nodes.map((node) => [node.id, node.name]));
  const calls = (nodeRuns ?? [])
    .flatMap((record) => record.toolCalls.map((call) => ({ call, nodeId: record.nodeId })))
    .filter(({ call }) => call.status === 'ok' && WRITE_TOOLS.has(call.toolName))
    .sort((a, b) => a.call.at.localeCompare(b.call.at));
  const files = new Map<string, WrittenFile>();
  for (const { call, nodeId } of calls) {
    const name = names.get(nodeId) ?? 'A node';
    for (const raw of writtenPaths(call.args)) {
      const path = projectPath(raw, folderPath);
      if (path === undefined) continue;
      const file = files.get(path) ?? { path, by: [] };
      if (!file.by.includes(name)) file.by.push(name);
      files.set(path, file);
    }
  }
  return [...files.values()];
}

/** What a node gave the run: the run's `finalOutput`, else its newest node run's output. */
function outputOf(run: Run, nodeRuns: readonly NodeRun[] | undefined, nodeId: string): Part[] {
  const recorded = run.finalOutput?.[nodeId];
  if (recorded !== undefined && recorded.length > 0) return recorded;
  const latest = [...(nodeRuns ?? [])]
    .reverse()
    .find((each) => each.nodeId === nodeId && each.output !== undefined);
  return latest?.output ?? [];
}

/** Why the run did not complete, one line each: pre-flight issues, a budget, failed nodes. */
function failureLines(run: Run, nodeRuns: readonly NodeRun[] | undefined): string[] {
  if (run.status === 'BLOCKED') return run.preflightIssues.map((issue) => issue.message);
  const names = new Map(run.snapshot.nodes.map((node) => [node.id, node.name]));
  const lines: string[] = [];
  if (run.budgetHalt !== undefined) {
    lines.push(
      `The ${run.budgetHalt.scope} budget was reached: $${run.budgetHalt.costUsd.toFixed(4)} of a $${run.budgetHalt.capUsd.toFixed(2)} cap.`,
    );
  }
  const seen = new Set<string>();
  for (const record of [...(nodeRuns ?? [])].reverse()) {
    if (record.status !== 'FAILED' || seen.has(record.nodeId)) continue;
    seen.add(record.nodeId);
    const name = names.get(record.nodeId) ?? 'A node';
    lines.push(
      record.error === undefined
        ? `${name} failed (${record.failureReason ?? 'RUN_FAILED'}).`
        : `${name} failed: ${record.error.message}`,
    );
  }
  return lines;
}
