import { cn } from '@ace/ui';
import { useRef, type KeyboardEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { useWorkflowMode, workflowPath, type WorkflowMode } from '../../forge/mode';
import { SHORTCUTS, shortcutLabel } from '../shortcuts';

const MODES: ReadonlyArray<{ mode: WorkflowMode; label: string; keys: string }> = [
  { mode: 'ideate', label: 'Ideate', keys: shortcutLabel(SHORTCUTS.ideate) },
  { mode: 'forge', label: 'Forge', keys: shortcutLabel(SHORTCUTS.forge) },
];

/**
 * The header's `Ideate | Forge` switch (D299; D367 moved Domain to the chat's Expand button), as
 * the theme's segmented pill (D330): a radio group, and the arrow keys move along it. One radio is
 * always the tab stop: the checked one, or Ideate in Domain, where none is ([audit F-12]).
 */
export function ModeSwitch({ projectId, workflowId }: { projectId: string; workflowId: string }) {
  const mode = useWorkflowMode();
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const checked = MODES.findIndex((entry) => entry.mode === (mode ?? 'ideate'));
  const stop = checked === -1 ? 0 : checked;
  const go = (next: WorkflowMode) => {
    // PG-3.2: the selected run and node travel with the switch.
    if (next !== mode) navigate(workflowPath(projectId, workflowId, next, search));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const step = event.key === 'ArrowRight' ? 1 : MODES.length - 1;
    const index = (stop + step) % MODES.length;
    const next = MODES[index]?.mode ?? 'ideate';
    go(next);
    buttons.current[index]?.focus();
  };
  return (
    <div
      role="radiogroup"
      aria-label="Mode"
      data-testid="mode-switch"
      onKeyDown={onKeyDown}
      className="flex shrink-0 gap-[2px] rounded-full border border-[var(--line)] bg-[var(--soft)] p-[3px]"
    >
      {MODES.map(({ mode: value, label, keys }, index) => (
        <button
          key={value}
          ref={(element) => {
            buttons.current[index] = element;
          }}
          type="button"
          role="radio"
          aria-checked={mode === value}
          tabIndex={index === stop ? 0 : -1}
          data-testid={`mode-${value}`}
          title={`${label} (${keys})`}
          onClick={() => go(value)}
          className={cn(
            'h-[26px] cursor-pointer rounded-full border px-4 text-[12px] font-semibold focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_var(--focus)]',
            mode === value
              ? 'border-[var(--seg)] bg-[var(--seg)] text-[var(--segInk)]'
              : 'border-transparent bg-transparent text-[var(--muted)]',
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
