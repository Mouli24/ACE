import type { NodeState } from '@ace/contracts';
import { Icons, type LucideIcon } from '@ace/ui';

/*
 * Formatting the Ace UI theme uses (D328): clock times like "3:38 PM", relative times like
 * "4m ago", initials, and the node-state labels and colours of its Stage cards.
 */

/** `3:38 PM`, in the viewer's locale — the theme's `now()`. */
export function clockTime(at: string | number | Date): string {
  return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** `Just now`, `4m ago`, `17h ago`, `2d ago`, `1w ago`. */
export function ago(at: string | number | Date, now: number = Date.now()): string {
  const seconds = Math.max(0, (now - new Date(at).getTime()) / 1000);
  if (seconds < 60) return 'Just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return `${Math.floor(days / 7)}w ago`;
}

/** The first letter of a name, uppercased; `?` for an empty one. */
export function initial(name: string): string {
  const letter = name.trim().match(/[\p{L}\p{N}]/u)?.[0];
  return letter ? letter.toUpperCase() : '?';
}

/**
 * A node state as the canvas shows it (PG-4.2, D360): a word, a colour and a glyph — each its
 * own, so no two of the nine states look alike and the colour is never the only signal. The colour
 * is the `--color-status-*` token, which `@ace/ui/theme.css` sets per theme at WCAG AA.
 */
export interface NodeStatusLook {
  label: string;
  color: string;
  icon: LucideIcon;
  /** RUNNING and WAITING are the states that move: their glyph animates. */
  live: boolean;
}

const tone = (state: NodeState): string => `var(--color-status-${state})`;

const LOOK: Record<NodeState, NodeStatusLook> = {
  IDLE: { label: 'Idle', color: tone('IDLE'), icon: Icons.Circle, live: false },
  READY: { label: 'Ready', color: tone('READY'), icon: Icons.CircleDot, live: false },
  RUNNING: { label: 'Running', color: tone('RUNNING'), icon: Icons.LoaderCircle, live: true },
  WAITING: { label: 'Waiting', color: tone('WAITING'), icon: Icons.Hourglass, live: true },
  COMPLETED: { label: 'Done', color: tone('COMPLETED'), icon: Icons.CircleCheck, live: false },
  PAUSED: { label: 'Paused', color: tone('PAUSED'), icon: Icons.CirclePause, live: false },
  STOPPED: { label: 'Stopped', color: tone('STOPPED'), icon: Icons.CircleStop, live: false },
  BLOCKED: { label: 'Blocked', color: tone('BLOCKED'), icon: Icons.Ban, live: false },
  FAILED: { label: 'Failed', color: tone('FAILED'), icon: Icons.CircleX, live: false },
};

export function nodeStatusLook(state: NodeState): NodeStatusLook {
  return LOOK[state];
}
