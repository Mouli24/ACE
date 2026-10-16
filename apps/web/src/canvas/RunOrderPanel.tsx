import { runPlan, type Edge, type Node, type NodeState } from '@ace/contracts';
import { Icons, cn } from '@ace/ui';
import { useMemo, useState, type DragEvent } from 'react';

import { NODE_KIND_LABEL, type CanvasNodeKind } from '../nodes/factory';
import { useRunStore } from '../runs/run-store';
import { agentMap } from '../theme/agents';
import { initial } from '../theme/format';
import { moveToStep, stepLook, type RunOrderEdit, type StepLook } from './run-order';

/** The drag payload a node row carries onto a step. */
const ROW_DRAG_TYPE = 'application/x-ace-run-order-node';

const ICON_BUTTON =
  'flex h-[22px] w-[22px] cursor-pointer items-center justify-center rounded-[6px] border-none bg-transparent p-0 text-[var(--muted)] outline-none hover:bg-[var(--hover)] hover:text-[var(--ink)] focus-visible:shadow-[0_0_0_2px_#ef6b3f] disabled:cursor-default disabled:opacity-40';

const STEP_LOOK: Record<StepLook, string> = {
  idle: 'border-[var(--line)]',
  active: 'border-[#ef6b3f] shadow-[0_0_0_3px_rgba(239,107,63,0.15)]',
  done: 'border-[var(--line)] opacity-80',
  failed: 'border-[#c94c27]',
};

/** A node's avatar: an Agent/Model in its own colour and letter (D328), anything else in grey. */
function Avatar({ node, color }: { node: Node; color: string | undefined }) {
  return (
    <span
      aria-hidden
      className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-[#fff]"
      style={{ background: color ?? 'var(--iconLine)' }}
    >
      {initial(node.name)}
    </span>
  );
}

/**
 * D373: the Run order panel — the plan `runPlan` gives, step by step: who runs first, who runs
 * together, who waits. Click a node to select and centre it; drag it onto another step (or use its
 * arrows) to move it there, which adds or removes "run after" links only. During a run of this
 * workflow the step being worked on is lit and the finished ones are ticked.
 */
export function RunOrderPanel({
  workflowId,
  nodes,
  edges,
  readOnly,
  onFocus,
  onEdit,
  onClose,
}: {
  workflowId: string;
  nodes: readonly Node[];
  edges: readonly Edge[];
  readOnly: boolean;
  onFocus: (nodeId: string) => void;
  onEdit: (edit: RunOrderEdit) => void;
  onClose: () => void;
}) {
  const plan = useMemo(() => runPlan(nodes, edges), [nodes, edges]);
  const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const agents = useMemo(() => agentMap(nodes), [nodes]);
  // `revision` moves when a frame lands, so the lit step follows the run.
  useRunStore((store) => store.revision);
  const runHere = useRunStore(
    (store) => store.workflowId === workflowId && store.runId !== undefined,
  );
  const state = (id: string): NodeState => useRunStore.getState().nodeState(id);
  const [dropStep, setDropStep] = useState<number>();

  const move = (nodeId: string, step: number) => {
    if (readOnly) return;
    onEdit(moveToStep(workflowId, nodes, edges, nodeId, step));
  };

  const dropProps = (step: number) => ({
    onDragOver: (event: DragEvent) => {
      if (readOnly || !event.dataTransfer.types.includes(ROW_DRAG_TYPE)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      setDropStep(step);
    },
    onDragLeave: () => setDropStep((at) => (at === step ? undefined : at)),
    onDrop: (event: DragEvent) => {
      const nodeId = event.dataTransfer.getData(ROW_DRAG_TYPE);
      setDropStep(undefined);
      if (nodeId === '') return;
      event.preventDefault();
      move(nodeId, step);
    },
  });

  return (
    <aside
      aria-label="Run order"
      data-testid="run-order-panel"
      className="nowheel nopan absolute right-[16px] top-[56px] z-[6] flex max-h-[calc(100%-120px)] w-[300px] max-w-[calc(100%-32px)] flex-col rounded-[12px] border border-[var(--line)] bg-[var(--surface)] shadow-[0_14px_34px_-16px_rgba(40,25,15,0.45)]"
    >
      <header className="flex items-center gap-[8px] border-b border-[var(--line)] px-[12px] py-[10px]">
        <Icons.ListOrdered aria-hidden size={14} className="text-[var(--muted)]" />
        <h2 className="m-0 flex-1 text-[13px] font-semibold text-[var(--ink)]">Run order</h2>
        <button
          type="button"
          aria-label="Close run order"
          title="Close"
          className={ICON_BUTTON}
          onClick={onClose}
        >
          <Icons.X aria-hidden size={13} />
        </button>
      </header>
      <p className="m-0 px-[12px] pt-[8px] text-[11.5px] leading-[1.4] text-[var(--muted)]">
        Steps run top to bottom; the nodes of one step run together.
        {!readOnly && ' Drag a node onto another step to move it.'}
      </p>
      <ol
        aria-label="Steps"
        className="m-0 flex list-none flex-col gap-[8px] overflow-y-auto p-[12px]"
      >
        {plan.length === 0 && (
          <li className="text-[12.5px] text-[var(--muted)]">This workflow has no nodes yet.</li>
        )}
        {plan.map(({ step, nodeIds }) => {
          const look = runHere ? stepLook(nodeIds, state) : 'idle';
          const names = nodeIds.map((id) => byId.get(id)?.name || 'Untitled');
          const summary = `Step ${step} — ${names.join(', ')}${nodeIds.length > 1 ? ' (together)' : ''}`;
          return (
            <li
              key={step}
              aria-label={summary}
              data-testid={`run-order-step-${step}`}
              data-look={look}
              aria-current={look === 'active' ? 'step' : undefined}
              className={cn(
                'rounded-[10px] border bg-[var(--soft)] px-[10px] py-[8px]',
                STEP_LOOK[look],
                dropStep === step && 'border-dashed border-[#ef6b3f]',
              )}
              {...dropProps(step)}
            >
              <div className="mb-[6px] flex items-center gap-[6px] text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--muted)]">
                {look === 'done' ? (
                  <Icons.CircleCheck aria-label="Done" size={13} className="text-[#2f9e6b]" />
                ) : look === 'active' ? (
                  <Icons.LoaderCircle
                    aria-label="Running"
                    size={13}
                    className="animate-spin text-[#ef6b3f]"
                  />
                ) : look === 'failed' ? (
                  <Icons.CircleAlert aria-label="Stopped" size={13} className="text-[#c94c27]" />
                ) : null}
                <span>Step {step}</span>
                {nodeIds.length > 1 && (
                  <span className="normal-case tracking-normal">· together</span>
                )}
              </div>
              <ul className="m-0 flex list-none flex-col gap-[4px] p-0">
                {nodeIds.map((id) => {
                  const node = byId.get(id);
                  if (node === undefined) return null;
                  const name = node.name || 'Untitled';
                  return (
                    <li
                      key={id}
                      data-testid={`run-order-node-${id}`}
                      draggable={!readOnly}
                      onDragStart={(event) => {
                        event.dataTransfer.setData(ROW_DRAG_TYPE, id);
                        event.dataTransfer.effectAllowed = 'move';
                      }}
                      className={cn(
                        'flex items-center gap-[6px] rounded-[8px] bg-[var(--surface)] px-[6px] py-[4px]',
                        !readOnly && 'cursor-grab',
                      )}
                    >
                      {!readOnly && (
                        <Icons.GripVertical
                          aria-hidden
                          size={12}
                          className="shrink-0 text-[var(--iconLine)]"
                        />
                      )}
                      <button
                        type="button"
                        aria-label={`Show ${name} on the canvas`}
                        title={`Show ${name} on the canvas`}
                        className="flex min-w-0 flex-1 cursor-pointer items-center gap-[8px] border-none bg-transparent p-0 text-left text-[12.5px] text-[var(--ink)] outline-none focus-visible:underline"
                        onClick={() => onFocus(id)}
                      >
                        <Avatar node={node} color={agents.get(id)?.color} />
                        <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
                        <span className="shrink-0 font-machine text-[10px] text-[var(--muted)]">
                          {NODE_KIND_LABEL[node.kind as CanvasNodeKind] ?? node.kind}
                        </span>
                      </button>
                      {!readOnly && (
                        <>
                          <button
                            type="button"
                            aria-label={`Move ${name} to step ${step - 1}`}
                            title="Run earlier"
                            className={ICON_BUTTON}
                            disabled={step === 1}
                            onClick={() => move(id, step - 1)}
                          >
                            <Icons.ChevronUp aria-hidden size={13} />
                          </button>
                          <button
                            type="button"
                            aria-label={`Move ${name} to step ${step + 1}`}
                            title="Run later"
                            className={ICON_BUTTON}
                            onClick={() => move(id, step + 1)}
                          >
                            <Icons.ChevronDown aria-hidden size={13} />
                          </button>
                        </>
                      )}
                    </li>
                  );
                })}
              </ul>
            </li>
          );
        })}
        {!readOnly && plan.length > 0 && (
          <li
            aria-label={`New step ${plan.length + 1}: drop a node here to run it last`}
            data-testid="run-order-new-step"
            className={cn(
              'rounded-[10px] border border-dashed border-[var(--line)] px-[10px] py-[8px] text-center text-[11.5px] text-[var(--muted)]',
              dropStep === plan.length + 1 && 'border-[#ef6b3f] text-[var(--ink)]',
            )}
            {...dropProps(plan.length + 1)}
          >
            Drop here to run last
          </li>
        )}
      </ol>
    </aside>
  );
}
