import { cn } from '@ace/ui';
import { Code2, MessagesSquare, Workflow, type LucideIcon } from 'lucide-react';
import { useRef, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';

import { useWorkflowMode, workflowPath, type WorkflowMode } from '../../forge/mode';
import { SHORTCUTS, shortcutLabel } from '../shortcuts';

const MODES: ReadonlyArray<{ mode: WorkflowMode; label: string; Icon: LucideIcon; keys: string }> =
  [
    { mode: 'ideate', label: 'Ideate', Icon: Workflow, keys: shortcutLabel(SHORTCUTS.ideate) },
    { mode: 'forge', label: 'Forge', Icon: Code2, keys: shortcutLabel(SHORTCUTS.forge) },
    {
      mode: 'domain',
      label: 'Domain',
      Icon: MessagesSquare,
      keys: shortcutLabel(SHORTCUTS.domain),
    },
  ];

/**
 * The top bar's `Ideate | Forge | Domain` switch (D299, D303): a radio group, and the arrow keys
 * move along it.
 */
export function ModeSwitch({ projectId, workflowId }: { projectId: string; workflowId: string }) {
  const mode = useWorkflowMode();
  const navigate = useNavigate();
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const go = (next: WorkflowMode) => {
    if (next !== mode) navigate(workflowPath(projectId, workflowId, next));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const at = MODES.findIndex((entry) => entry.mode === (mode ?? 'ideate'));
    const step = event.key === 'ArrowRight' ? 1 : MODES.length - 1;
    const index = (at + step) % MODES.length;
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
      className="flex shrink-0 items-center gap-[3px] rounded-chip border border-border bg-card p-[3px]"
    >
      {MODES.map(({ mode: value, label, Icon, keys }, index) => (
        <button
          key={value}
          ref={(element) => {
            buttons.current[index] = element;
          }}
          type="button"
          role="radio"
          aria-checked={mode === value}
          tabIndex={(mode ?? 'ideate') === value ? 0 : -1}
          data-testid={`mode-${value}`}
          title={`${label} (${keys})`}
          onClick={() => go(value)}
          className={cn(
            'flex h-[26px] items-center gap-1.5 rounded-chip px-3 font-machine text-[10.5px] uppercase tracking-[0.1em] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
            mode === value ? 'bg-fg text-canvas' : 'text-fg-muted hover:text-fg',
          )}
        >
          <Icon className="h-3.5 w-3.5" aria-hidden />
          {label}
        </button>
      ))}
    </div>
  );
}
