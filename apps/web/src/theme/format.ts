import type { NodeState } from '@ace/contracts';

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

/** A node state as the theme's Stage cards show it: a word and a dot colour. */
export interface NodeStatusLook {
  label: string;
  color: string;
}

const LOOK: Record<NodeState, NodeStatusLook> = {
  IDLE: { label: 'Idle', color: '#a39d97' },
  READY: { label: 'Ready', color: '#a39d97' },
  RUNNING: { label: 'Running', color: '#ef6b3f' },
  WAITING: { label: 'Waiting', color: '#a39d97' },
  COMPLETED: { label: 'Done', color: '#2f9e63' },
  PAUSED: { label: 'Paused', color: '#a39d97' },
  STOPPED: { label: 'Stopped', color: '#a39d97' },
  BLOCKED: { label: 'Blocked', color: '#c94c27' },
  FAILED: { label: 'Failed', color: '#c94c27' },
};

export function nodeStatusLook(state: NodeState): NodeStatusLook {
  return LOOK[state];
}
