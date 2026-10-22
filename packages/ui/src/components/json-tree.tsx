import { ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';

import { cn } from '../lib/cn.js';
import { SYNTAX_PALETTE_CLASS } from './code-block.js';

/**
 * A `json` part as a collapsible tree (FR-MM-006, round 4 §5 item 3).
 *
 * Objects and arrays are `<details>` — native disclosure, so it is keyboard-operable and needs no
 * focus management of its own — with the root open and everything below it collapsed, so a large
 * value opens small and expands on demand. Primitives render inline in a colour per JSON type.
 * Everything wraps, so a long string does not push the panel past 380 px (NFR-USE-03).
 *
 * In the theme (D328): JetBrains Mono 12px on the canvas colour, radius 8, the ▸ / ▾ carets of its
 * explorer, and its syntax palette — strings `str`, numbers `num`, booleans `kw`, null `com`, keys
 * `fn` — light or dark via {@link SYNTAX_PALETTE_CLASS}.
 */

export interface JsonTreeProps {
  value: unknown;
  /** How deep to leave open on first render; the root (0) is open, its children closed. */
  defaultExpandedDepth?: number;
  className?: string;
}

function typeColor(value: unknown): string {
  if (typeof value === 'string') return 'text-[var(--syn-str)]';
  if (typeof value === 'number') return 'text-[var(--syn-num)]';
  if (typeof value === 'boolean') return 'text-[var(--syn-kw)]';
  return 'text-[var(--syn-com)]';
}

function Primitive({ value }: { value: unknown }) {
  const text =
    typeof value === 'string'
      ? JSON.stringify(value)
      : value === undefined
        ? 'undefined'
        : String(value);
  return (
    <span
      className={cn('break-all font-machine text-[12px]', typeColor(value))}
      data-testid="json-primitive"
    >
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
      <span className="font-machine text-[12px] text-[var(--syn-fn)]">{name}: </span>
    );

  if (!isObject) {
    return (
      <div className="py-px pl-[14px]">
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
      <summary className="flex cursor-pointer list-none items-center gap-1 rounded-[4px] py-px outline-none hover:bg-[var(--hover)] focus-visible:shadow-[0_0_0_2px_var(--focus)] [&::-webkit-details-marker]:hidden">
        <span aria-hidden className="w-[10px] shrink-0 text-[10px] text-[var(--muted)]">
          {open ? <ChevronDown aria-hidden size={10} /> : <ChevronRight aria-hidden size={10} />}
        </span>
        {label}
        <span className="font-machine text-[12px] text-[var(--muted)]">{summary}</span>
      </summary>
      <div className="ml-[4px] border-l border-[var(--line)] pl-[10px]">
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
      className={cn(
        'overflow-x-auto rounded-[8px] border border-[var(--line)] bg-[var(--canvas)] px-3 py-[10px] font-machine text-[12px] leading-[1.55] text-[var(--ink)]',
        SYNTAX_PALETTE_CLASS,
        className,
      )}
    >
      <Node value={value} depth={0} defaultExpandedDepth={defaultExpandedDepth} />
    </div>
  );
}
