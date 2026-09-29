import { ChevronRight } from 'lucide-react';
import { useState } from 'react';

import { cn } from '../lib/cn.js';

/**
 * A `json` part as a collapsible tree (FR-MM-006, round 4 §5 item 3).
 *
 * Objects and arrays are `<details>` — native disclosure, so it is keyboard-operable and needs no
 * focus management of its own — with the root open and everything below it collapsed, so a large
 * value opens small and expands on demand. Primitives render inline in a colour per JSON type.
 * Everything wraps, so a long string does not push the panel past 380 px (NFR-USE-03).
 */

export interface JsonTreeProps {
  value: unknown;
  /** How deep to leave open on first render; the root (0) is open, its children closed. */
  defaultExpandedDepth?: number;
  className?: string;
}

function typeColor(value: unknown): string {
  if (typeof value === 'string') return 'text-[var(--color-status-COMPLETED)]';
  if (typeof value === 'number') return 'text-[var(--color-status-WAITING)]';
  if (typeof value === 'boolean') return 'text-accent';
  return 'text-fg-muted';
}

function Primitive({ value }: { value: unknown }) {
  const text =
    typeof value === 'string' ? JSON.stringify(value) : value === undefined ? 'undefined' : String(value);
  return (
    <span className={cn('break-all font-machine text-xs', typeColor(value))} data-testid="json-primitive">
      {text}
    </span>
  );
}

interface NodeProps {
  name?: string;
  value: unknown;
  depth: number;
  defaultExpandedDepth: number;
}

function Node({ name, value, depth, defaultExpandedDepth }: NodeProps) {
  const isArray = Array.isArray(value);
  const isObject = value !== null && typeof value === 'object';
  const [open, setOpen] = useState(depth < defaultExpandedDepth);

  const label =
    name === undefined ? null : (
      <span className="font-machine text-xs text-fg-muted">{name}: </span>
    );

  if (!isObject) {
    return (
      <div className="py-0.5 pl-4" style={{ marginLeft: depth === 0 ? 0 : undefined }}>
        {label}
        <Primitive value={value} />
      </div>
    );
  }

  const entries: Array<[string, unknown]> = isArray
    ? (value as unknown[]).map((item, index) => [String(index), item])
    : Object.entries(value as Record<string, unknown>);
  const open_ = isArray ? '[' : '{';
  const close = isArray ? ']' : '}';
  const summary = entries.length === 0 ? `${open_}${close}` : `${open_} ${entries.length} ${close}`;

  return (
    <details
      open={open}
      onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}
      data-testid="json-node"
    >
      <summary className="flex cursor-pointer list-none items-center gap-1 py-0.5 hover:bg-border/40">
        <ChevronRight
          className={cn('h-3 w-3 shrink-0 text-fg-muted transition-transform', open && 'rotate-90')}
          aria-hidden
        />
        {label}
        <span className="font-machine text-xs text-fg-muted">{summary}</span>
      </summary>
      <div className="border-l border-border pl-3">
        {entries.map(([key, child]) => (
          <Node
            key={key}
            name={key}
            value={child}
            depth={depth + 1}
            defaultExpandedDepth={defaultExpandedDepth}
          />
        ))}
      </div>
    </details>
  );
}

export function JsonTree({ value, defaultExpandedDepth = 1, className }: JsonTreeProps) {
  return (
    <div
      data-testid="json-tree"
      className={cn('overflow-x-auto rounded border border-border bg-canvas p-2 text-fg', className)}
    >
      <Node value={value} depth={0} defaultExpandedDepth={defaultExpandedDepth} />
    </div>
  );
}
