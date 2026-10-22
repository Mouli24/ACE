import type { Node, NodeRun, Run, Usage } from '@ace/contracts';
import { StatusRing } from '@ace/ui';
import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { TOUCH_TARGETS } from '../../responsive/touch';
import { useIsCompact } from '../../responsive/useIsCompact';
import { CostValue } from '../CostValue';
import { useNodeRunsOnce, useRun, useRuns } from '../hooks';
import { CHIP_CLASS, RunStateChip } from '../RunStateChip';
import { diffLines, finalNodeRuns, outputText, type DiffLine } from './diff';

/** The theme's small-caps section label (D328). */
const SECTION_LABEL =
  'm-0 font-machine text-[9.5px] font-medium uppercase tracking-[0.1em] text-[var(--muted)]';

const CARD = 'overflow-hidden rounded-[12px] border border-[var(--line)] bg-[var(--surface)]';

const money = (value: number) => `$${value.toFixed(4)}`;

const durationText = (ms: number | undefined): string => {
  if (ms === undefined) return '—';
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
};

const shortId = (id: string) => id.slice(-6);

/**
 * `/runs/compare?a=<runId>&b=<runId>` (PG-5.4): two runs side by side — each node's output as a
 * line diff (JSON pretty-printed with sorted keys first), its tokens, its cost (an unknown cost
 * stays unknown, D359) and its time. Read from the same GETs as Run detail; nothing is recorded.
 *
 * With only `a`, the page asks which run of the same workflow to compare it with.
 */
export function RunComparePage() {
  const [params, setParams] = useSearchParams();
  const a = params.get('a') ?? undefined;
  const b = params.get('b') ?? undefined;
  const compact = useIsCompact();

  const runA = useRun(a);
  const runB = useRun(b);
  const nodeRunsA = useNodeRunsOnce(a);
  const nodeRunsB = useNodeRunsOnce(b);

  const pick = (key: 'a' | 'b', id: string) => {
    const next = new URLSearchParams(params);
    next.set(key, id);
    setParams(next);
  };

  return (
    <main
      className={`mx-auto flex h-full w-full min-w-0 max-w-[1200px] flex-col gap-6 overflow-y-auto text-[var(--ink)] ${compact ? `px-4 py-4 ${TOUCH_TARGETS}` : 'px-6 py-8'}`}
      data-testid="run-compare"
    >
      <header className="flex flex-wrap items-center gap-[10px]">
        <h1 className="m-0 text-[20px] font-bold tracking-[-0.01em]">Compare runs</h1>
        <span className="text-[12px] text-[var(--muted)]">
          Outputs, tokens, cost and time, node by node.
        </span>
      </header>

      {a === undefined ? (
        <p className="text-[13px] text-[var(--muted)]">
          Pick two runs to compare from a project&apos;s Runs page, or open a run and choose
          Compare.
        </p>
      ) : runA.isError ? (
        <p role="alert" className="text-[13px] text-danger">
          Could not load run {shortId(a)}: {runA.error.message}
        </p>
      ) : !runA.data ? (
        <p className="text-[13px] text-[var(--muted)]">Loading run…</p>
      ) : b === undefined ? (
        <PickRun run={runA.data} onPick={(id) => pick('b', id)} title="Compare this run with…" />
      ) : runB.isError ? (
        <p role="alert" className="text-[13px] text-danger">
          Could not load run {shortId(b)}: {runB.error.message}
        </p>
      ) : !runB.data ? (
        <p className="text-[13px] text-[var(--muted)]">Loading run…</p>
      ) : (
        <Comparison
          left={runA.data}
          right={runB.data}
          leftNodeRuns={nodeRunsA.data ?? []}
          rightNodeRuns={nodeRunsB.data ?? []}
          loading={nodeRunsA.isPending || nodeRunsB.isPending}
          onSwap={() => {
            const next = new URLSearchParams(params);
            next.set('a', b);
            next.set('b', a);
            setParams(next);
          }}
        />
      )}
    </main>
  );
}

/** The workflow's other runs, newest first, to choose the second side from. */
function PickRun({
  run,
  onPick,
  title,
}: {
  run: Run;
  onPick: (runId: string) => void;
  title: string;
}) {
  const runs = useRuns(run.workflowId);
  const others = (runs.data ?? []).filter((candidate) => candidate.id !== run.id);
  return (
    <section className="flex flex-col gap-[10px]" data-testid="run-compare-pick">
      <h2 className={SECTION_LABEL}>{title}</h2>
      {runs.isPending && <p className="text-[13px] text-[var(--muted)]">Loading runs…</p>}
      {!runs.isPending && others.length === 0 && (
        <p className="text-[13px] text-[var(--muted)]">This workflow has no other run yet.</p>
      )}
      <ul className={`${CARD} m-0 flex list-none flex-col p-0`}>
        {others.map((candidate) => (
          <li key={candidate.id} className="border-t border-[var(--line)] first:border-t-0">
            <button
              type="button"
              data-testid={`run-compare-pick-${candidate.id}`}
              onClick={() => onPick(candidate.id)}
              className="flex min-h-11 w-full cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 bg-transparent px-[14px] py-[8px] text-left text-[12.5px] text-[var(--ink)] outline-none hover:bg-[var(--hover)] focus-visible:shadow-[0_0_0_2px_var(--focus)]"
            >
              <span>{new Date(candidate.startedAt).toLocaleString()}</span>
              <RunStateChip
                status={candidate.status}
                {...(candidate.haltReason === undefined
                  ? {}
                  : { haltReason: candidate.haltReason })}
              />
              {candidate.replayOf !== undefined && (
                <span className={`${CHIP_CLASS} bg-[var(--hover)] text-[var(--muted)]`}>
                  replay
                </span>
              )}
              <span className="ml-auto font-machine text-[11px] text-[var(--muted)]">
                {candidate.totals.tokensIn}↓ {candidate.totals.tokensOut}↑{' '}
                <CostValue usage={candidate.totals} format={money} />
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** One row of the comparison: a node, matched across the two snapshots. */
interface NodePair {
  key: string;
  name: string;
  kind: Node['kind'];
  left: NodeRun | undefined;
  right: NodeRun | undefined;
  inLeft: boolean;
  inRight: boolean;
}

/**
 * The nodes of both runs in the left run's order, then any only the right run has. A node is matched
 * by id (a replay or a restart keeps them); across two workflows, by name.
 */
function pairNodes(
  left: Run,
  right: Run,
  leftRows: Map<string, NodeRun>,
  rightRows: Map<string, NodeRun>,
): NodePair[] {
  const rightById = new Map(right.snapshot.nodes.map((node) => [node.id, node]));
  const rightByName = new Map(right.snapshot.nodes.map((node) => [node.name, node]));
  const matched = new Set<string>();
  const pairs: NodePair[] = [];
  for (const node of left.snapshot.nodes) {
    const other = rightById.get(node.id) ?? rightByName.get(node.name);
    if (other !== undefined) matched.add(other.id);
    pairs.push({
      key: node.id,
      name: node.name,
      kind: node.kind,
      left: leftRows.get(node.id),
      right: other === undefined ? undefined : rightRows.get(other.id),
      inLeft: true,
      inRight: other !== undefined,
    });
  }
  for (const node of right.snapshot.nodes) {
    if (matched.has(node.id)) continue;
    pairs.push({
      key: `right-${node.id}`,
      name: node.name,
      kind: node.kind,
      left: undefined,
      right: rightRows.get(node.id),
      inLeft: false,
      inRight: true,
    });
  }
  return pairs;
}

function Comparison({
  left,
  right,
  leftNodeRuns,
  rightNodeRuns,
  loading,
  onSwap,
}: {
  left: Run;
  right: Run;
  leftNodeRuns: readonly NodeRun[];
  rightNodeRuns: readonly NodeRun[];
  loading: boolean;
  onSwap: () => void;
}) {
  const pairs = useMemo(
    () => pairNodes(left, right, finalNodeRuns(leftNodeRuns), finalNodeRuns(rightNodeRuns)),
    [left, right, leftNodeRuns, rightNodeRuns],
  );
  const changed = pairs.filter(
    (pair) => outputText(pair.left?.output) !== outputText(pair.right?.output),
  ).length;

  return (
    <>
      <section className="grid grid-cols-1 gap-[10px] md:grid-cols-[1fr_auto_1fr]">
        <RunSummaryCard run={left} side="A" />
        <button
          type="button"
          onClick={onSwap}
          data-testid="run-compare-swap"
          aria-label="Swap the two runs"
          title="Swap the two runs"
          className="h-[28px] self-center rounded-[8px] border border-[var(--line)] bg-[var(--chip)] px-3 text-[12px] font-semibold text-[var(--ink)] outline-none hover:bg-[var(--hover)] focus-visible:shadow-[0_0_0_2px_var(--focus)]"
        >
          ⇄
        </button>
        <RunSummaryCard run={right} side="B" />
      </section>

      <section className="flex flex-col gap-[10px]" data-testid="run-compare-nodes">
        <h2 className={SECTION_LABEL}>
          Nodes · {loading ? 'loading…' : `${changed} of ${pairs.length} outputs differ`}
        </h2>
        <ul className="m-0 flex list-none flex-col gap-[10px] p-0">
          {pairs.map((pair) => (
            <NodeComparison key={pair.key} pair={pair} />
          ))}
        </ul>
      </section>
    </>
  );
}

function RunSummaryCard({ run, side }: { run: Run; side: 'A' | 'B' }) {
  return (
    <div className={`${CARD} flex min-w-0 flex-col gap-[6px] px-[14px] py-[11px]`}>
      <span className="flex flex-wrap items-center gap-[8px]">
        <span className={`${CHIP_CLASS} bg-[var(--hover)] text-[var(--ink)]`}>{side}</span>
        <Link
          to={`/runs/${run.id}`}
          className="font-machine text-[12px] text-[var(--ink)]"
          data-testid={`run-compare-${side.toLowerCase()}`}
        >
          run …{shortId(run.id)}
        </Link>
        <RunStateChip
          status={run.status}
          {...(run.haltReason === undefined ? {} : { haltReason: run.haltReason })}
        />
        {run.replayOf !== undefined && (
          <span className={`${CHIP_CLASS} bg-[var(--hover)] text-[var(--muted)]`}>
            replay of …{shortId(run.replayOf)}
          </span>
        )}
        {run.restartedFromRunId !== undefined && (
          <span className={`${CHIP_CLASS} bg-[var(--hover)] text-[var(--muted)]`}>
            restart of …{shortId(run.restartedFromRunId)}
          </span>
        )}
      </span>
      <span className="text-[12px] text-[var(--muted)]">
        {new Date(run.startedAt).toLocaleString()} · {durationText(run.durationMs)}
      </span>
      <UsageLine usage={run.totals} />
    </div>
  );
}

function UsageLine({ usage, testId }: { usage: Usage; testId?: string }) {
  return (
    <span className="font-machine text-[11.5px] text-[var(--muted)]" data-testid={testId}>
      {usage.tokensIn}↓ {usage.tokensOut}↑ <CostValue usage={usage} format={money} />
    </span>
  );
}

function NodeSide({ nodeRun, present }: { nodeRun: NodeRun | undefined; present: boolean }) {
  if (!present) {
    return <span className="text-[12px] text-[var(--muted)]">not in this run</span>;
  }
  if (nodeRun === undefined) {
    return <span className="text-[12px] text-[var(--muted)]">not run</span>;
  }
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
      <StatusRing state={nodeRun.status} showLabel />
      <UsageLine usage={nodeRun.usage} />
      <span className="font-machine text-[11px] text-[var(--muted)]">
        {durationText(nodeRun.durationMs)}
      </span>
      {nodeRun.modelUsed && (
        <span className="font-machine text-[11px] text-[var(--muted)]">
          {nodeRun.modelUsed.resolvedModelId ?? nodeRun.modelUsed.modelId}
        </span>
      )}
    </span>
  );
}

const LINE_CLASS: Readonly<Record<DiffLine['kind'], string>> = {
  same: 'text-[var(--ink)]',
  removed: 'bg-[rgba(201,76,39,0.12)] text-[var(--ink)]',
  added: 'bg-[rgba(47,158,99,0.14)] text-[var(--ink)]',
};

const LINE_MARK: Readonly<Record<DiffLine['kind'], string>> = {
  same: ' ',
  removed: '−',
  added: '+',
};

function NodeComparison({ pair }: { pair: NodePair }) {
  const leftText = outputText(pair.left?.output);
  const rightText = outputText(pair.right?.output);
  const same = leftText === rightText;
  const lines = useMemo(
    () => (same ? [] : diffLines(leftText, rightText)),
    [same, leftText, rightText],
  );

  return (
    <li className={`${CARD} flex min-w-0 flex-col`} data-testid={`run-compare-node-${pair.key}`}>
      <span className="flex flex-wrap items-center gap-2 border-b border-[var(--line)] px-[14px] py-[10px] text-[13px] font-bold">
        <span className="min-w-0 truncate">{pair.name}</span>
        <span className={`${CHIP_CLASS} bg-[var(--hover)] font-normal text-[var(--muted)]`}>
          {pair.kind}
        </span>
        <span
          className={`${CHIP_CLASS} ml-auto font-normal ${same ? 'bg-[var(--hover)] text-[var(--muted)]' : 'bg-[#ef6b3f1f] text-danger'}`}
          data-testid={`run-compare-node-${pair.key}-verdict`}
        >
          {same ? 'same output' : 'output differs'}
        </span>
      </span>
      <div className="grid grid-cols-1 gap-x-4 gap-y-1 border-b border-[var(--line)] px-[14px] py-[8px] md:grid-cols-2">
        <span className="flex min-w-0 items-center gap-2">
          <span className="font-machine text-[10px] text-[var(--muted)]">A</span>
          <NodeSide nodeRun={pair.left} present={pair.inLeft} />
        </span>
        <span className="flex min-w-0 items-center gap-2">
          <span className="font-machine text-[10px] text-[var(--muted)]">B</span>
          <NodeSide nodeRun={pair.right} present={pair.inRight} />
        </span>
      </div>
      {same ? (
        leftText === '' ? (
          <p className="m-0 px-[14px] py-[8px] text-[12px] text-[var(--muted)]">No output.</p>
        ) : (
          <pre className="m-0 max-h-[240px] overflow-auto whitespace-pre-wrap break-words px-[14px] py-[8px] font-machine text-[11.5px] text-[var(--muted)]">
            {leftText}
          </pre>
        )
      ) : (
        <div
          className="max-h-[420px] overflow-auto"
          data-testid={`run-compare-node-${pair.key}-diff`}
        >
          <pre className="m-0 min-w-fit py-[6px] font-machine text-[11.5px]">
            {lines.map((line, index) => (
              <div
                key={index}
                data-kind={line.kind}
                className={`whitespace-pre px-[14px] ${LINE_CLASS[line.kind]}`}
              >
                <span aria-hidden className="mr-2 select-none text-[var(--muted)]">
                  {LINE_MARK[line.kind]}
                </span>
                <span className="sr-only">
                  {line.kind === 'same'
                    ? ''
                    : line.kind === 'added'
                      ? 'only in B: '
                      : 'only in A: '}
                </span>
                {line.text}
              </div>
            ))}
          </pre>
        </div>
      )}
    </li>
  );
}
