import { cn } from '@ace/ui';
import type { DragEvent, KeyboardEvent } from 'react';

import { KIND_ICON } from '../nodes/NodeCard';
import { NODE_KIND_LABEL, ROUND_1_NODE_KINDS, type Round1NodeKind } from '../nodes/factory';

/** The MIME type the palette puts on a drag so the Canvas knows what was dropped (FR-CAN-002). */
export const PALETTE_DRAG_TYPE = 'application/x-ace-node-kind';

const DESCRIPTION: Record<Round1NodeKind, string> = {
  input: 'Text or files the run starts from',
  agent: 'A model with instructions and typed ports',
  model: 'A bare model call',
  output: 'Marks the end; shows the final result',
  merge: 'Waits for all or any inputs',
  transform: 'Template, extract JSON field, join',
};

export interface PaletteProps {
  workflowId: string;
  /** Click or Enter on an entry: add the node at the centre of the current view (FR-CAN-002). */
  onAdd?: (kind: Round1NodeKind) => void;
}

/** Left pane: the six round-1 node kinds, click-to-add or drag-to-drop (FR-NODE-001, FR-CAN-002). */
export function Palette({ workflowId, onAdd }: PaletteProps) {
  const onDragStart = (event: DragEvent, kind: Round1NodeKind) => {
    event.dataTransfer.setData(PALETTE_DRAG_TYPE, kind);
    event.dataTransfer.effectAllowed = 'move';
  };
  const onKeyDown = (event: KeyboardEvent, kind: Round1NodeKind) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onAdd?.(kind);
    }
  };

  return (
    <aside
      className="flex h-full flex-col gap-1 overflow-y-auto p-2"
      aria-label="Node palette"
      data-workflow-id={workflowId}
    >
      <h2 className="px-2 py-1 font-machine text-[10px] uppercase tracking-wider text-fg-muted">
        Nodes
      </h2>
      {ROUND_1_NODE_KINDS.map((kind) => {
        const Icon = KIND_ICON[kind];
        return (
          <button
            key={kind}
            type="button"
            draggable
            data-testid={`palette-${kind}`}
            onDragStart={(e) => onDragStart(e, kind)}
            onClick={() => onAdd?.(kind)}
            onKeyDown={(e) => onKeyDown(e, kind)}
            className={cn(
              'flex cursor-grab items-start gap-2 rounded-md border border-transparent px-2 py-1.5 text-left',
              'hover:border-border hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
            )}
            title={`Add ${NODE_KIND_LABEL[kind]} node (click, Enter, or drag onto the Canvas)`}
          >
            <Icon className="mt-0.5 h-4 w-4 shrink-0 text-fg-muted" aria-hidden />
            <span className="flex min-w-0 flex-col">
              <span className="font-human text-sm">{NODE_KIND_LABEL[kind]}</span>
              <span className="truncate text-[11px] text-fg-muted">{DESCRIPTION[kind]}</span>
            </span>
          </button>
        );
      })}
      <p className="mt-auto px-2 py-2 text-[11px] text-fg-muted">
        Retrieval, Guardrail and Custom nodes arrive in Rounds 5 and 6+.
      </p>
    </aside>
  );
}
