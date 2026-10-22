import type { McpServerStatus, ToolPermissions } from '@ace/contracts';
import type { HTMLAttributes } from 'react';

import { cn } from '../lib/cn.js';

/**
 * A tool's permissions as small badges, and an MCP server's status as a chip (FR-TOOL-001/007,
 * round 4 §5 items 6/6). All token-driven and reusable — the tools table, the config panel's Tools
 * section and the inspector all show the same three facts about a tool: does it reach the network,
 * which folders can it touch, and is it destructive. Destructive is the one that carries a warning
 * colour, because it is the one that makes a call wait for approval (FR-GRD-006, BR-14).
 *
 * In the theme (D328) the badges are its mono chips — 8.5px, 0.08em, radius 4, a colour on itself at
 * 12% (`colour + '1f'`) — and the server chip is its "live" pill with a 6px dot.
 */

/* -------------------------------------------------------------------------- */
/* Permission badges                                                           */
/* -------------------------------------------------------------------------- */

const badgeBase =
  'inline-flex items-center gap-1 rounded-[4px] px-[6px] py-[2px] font-machine text-[8.5px] font-medium uppercase leading-[1.4] tracking-[0.08em]';

export interface ToolPermissionBadgesProps extends Omit<
  HTMLAttributes<HTMLSpanElement>,
  'children'
> {
  permissions: ToolPermissions;
  /** Show a neutral "sandboxed" badge when a tool has no network, no paths and is not destructive. */
  showNone?: boolean;
}

/** The badge row for a tool's `ToolPermissions`. */
export function ToolPermissionBadges({
  permissions,
  showNone = true,
  className,
  ...props
}: ToolPermissionBadgesProps) {
  const { network, fsPaths, destructive } = permissions;
  const none = !network && fsPaths.length === 0 && !destructive;

  return (
    <span
      data-testid="tool-permission-badges"
      className={cn('inline-flex flex-wrap items-center gap-[5px]', className)}
      {...props}
    >
      {network && (
        <span
          data-testid="perm-network"
          title="Reaches the network"
          className={cn(badgeBase, 'bg-[#1f97a31f] text-[#1f97a3]')}
        >
          network
        </span>
      )}
      {fsPaths.map((path) => (
        <span
          key={path}
          data-testid="perm-fs"
          title={`Reads/writes ${path}`}
          className={cn(badgeBase, 'bg-[var(--hover)] normal-case text-[var(--muted)]')}
        >
          <span className="max-w-[10rem] truncate">{path}</span>
        </span>
      ))}
      {destructive && (
        <span
          data-testid="perm-destructive"
          title="Destructive — a call waits for your approval"
          className={cn(badgeBase, 'bg-[#c94c271f] text-danger')}
        >
          destructive
        </span>
      )}
      {none && showNone && (
        <span
          data-testid="perm-none"
          title="No network, no file access, not destructive"
          className={cn(badgeBase, 'bg-[var(--hover)] text-[var(--muted)]')}
        >
          sandboxed
        </span>
      )}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* MCP server status chip                                                      */
/* -------------------------------------------------------------------------- */

/** Human wording and colour for the three MCP server states (§2.2); the enum stays the contract. */
export const MCP_STATUS_META: Readonly<
  Record<McpServerStatus, { label: string; color: string; pulse?: boolean }>
> = {
  starting: { label: 'starting', color: 'var(--color-provider-status-CHECKING)', pulse: true },
  connected: { label: 'connected', color: 'var(--color-provider-status-CONNECTED)' },
  unreachable: { label: 'unreachable', color: 'var(--color-provider-status-UNREACHABLE)' },
};

export interface McpServerStatusChipProps extends Omit<
  HTMLAttributes<HTMLSpanElement>,
  'children'
> {
  name: string;
  status: McpServerStatus;
  /** Tools this server contributed at its last check. */
  toolCount?: number;
}

/** An MCP server's liveness and tool count, for the servers panel (FR-TOOL-007). */
export function McpServerStatusChip({
  name,
  status,
  toolCount,
  className,
  ...props
}: McpServerStatusChipProps) {
  const meta = MCP_STATUS_META[status];
  return (
    <span
      data-testid={`mcp-chip-${name}`}
      data-status={status}
      title={`${name}: ${meta.label}`}
      className={cn(
        'inline-flex h-[24px] items-center gap-[5px] rounded-full border border-[var(--line)] px-[9px]',
        'font-machine text-[10px] text-[var(--muted)]',
        className,
      )}
      {...props}
    >
      <span
        aria-hidden
        className={cn(
          'h-[6px] w-[6px] shrink-0 rounded-full',
          meta.pulse && 'motion-safe:animate-[livePulse_2s_ease-in-out_infinite]',
        )}
        style={{ backgroundColor: meta.color }}
      />
      <span className="max-w-[10rem] truncate text-[var(--ink)]">{name}</span>
      <span>{meta.label}</span>
      {toolCount !== undefined && (
        <span data-testid={`mcp-toolcount-${name}`}>
          · {toolCount} {toolCount === 1 ? 'tool' : 'tools'}
        </span>
      )}
    </span>
  );
}
