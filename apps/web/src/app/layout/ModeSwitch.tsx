import { cn } from '@ace/ui';
import { Code2, Workflow, type LucideIcon } from 'lucide-react';
import { useRef, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';

import { useWorkflowMode, workflowPath, type WorkflowMode } from '../../forge/mode';
import { SHORTCUTS, shortcutLabel } from '../shortcuts';

const MODES: ReadonlyArray<{ mode: WorkflowMode; label: string; Icon: LucideIcon; keys: string }> =
  [
    { mode: 'ideate', label: 'Ideate', Icon: Workflow, keys: shortcutLabel(SHORTCUTS.ideate) },
    { mode: 'forge', label: 'Forge', Icon: Code2, keys: shortcutLabel(SHORTCUTS.forge) },
  ];

/** The top bar's `Ideate | Forge` switch (D299): a radio group, arrow keys move between the two. */
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
    const next: WorkflowMode = mode === 'ideate' ? 'forge' : 'ideate';
    go(next);
    buttons.current[next === 'ideate' ? 0 : 1]?.focus();
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
          tabIndex={mode === value ? 0 : -1}
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
