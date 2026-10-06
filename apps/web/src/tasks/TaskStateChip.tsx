import type { TaskState } from '@ace/contracts';
import { Tooltip, TooltipContent, TooltipTrigger, cn } from '@ace/ui';
import { LoaderCircle } from 'lucide-react';

import { STATE_COLOR, STATE_LABEL } from './meta';

/**
 * What is happening in a task's stage, in the status-chip treatment of the node states: a spinner
 * while running, a pulsing dot while waiting on a person, a filled dot otherwise, then the word — so
 * colour alone never carries it. `idle` and `done` are the quiet states and are not shown unless
 * asked (`always`). The reason, when there is one, is a tooltip and part of the chip's name.
 */
export function TaskStateChip({
  state,
  reason,
  always = false,
  className,
}: {
  state: TaskState;
  reason?: string | undefined;
  always?: boolean;
  className?: string;
}) {
  if (!always && (state === 'idle' || state === 'done')) return null;
  const label = STATE_LABEL[state];
  const chip = (
    <span
      data-testid="task-state"
      data-state={state}
      role="img"
      aria-label={reason ? `${label}: ${reason}` : label}
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 font-machine text-[10.5px] leading-4',
        className,
      )}
      style={{ color: STATE_COLOR[state] }}
    >
      {state === 'running' ? (
        <LoaderCircle className="ace-spin h-3 w-3 shrink-0" aria-hidden />
      ) : (
        <span
          aria-hidden
          className={cn(
            'h-[7px] w-[7px] shrink-0 rounded-full',
            state === 'waiting' && 'ace-pulse',
            state === 'idle' ? 'border border-current' : 'bg-current',
          )}
        />
      )}
      <span aria-hidden>{label}</span>
    </span>
  );
  if (!reason) return chip;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{chip}</TooltipTrigger>
      <TooltipContent className="max-w-xs font-human text-xs">{reason}</TooltipContent>
    </Tooltip>
  );
}
