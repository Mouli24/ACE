import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Icons,
} from '@ace/ui';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

/**
 * The phone header's menu (FR-MOB-001): the project's runs, Usage, Guardrail policies, Providers,
 * Onboarding, Settings and Help behind one button. `status` is the provider status and the day's totals, shown at the
 * top of the menu instead of squeezed into a 380 px bar. The trigger is the theme's "…" pill
 * inside a 44 px touch target.
 */
export function CompactMenu({ projectId, status }: { projectId?: string; status?: ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Menu"
          data-testid="topbar-menu"
          className="group flex min-h-11 min-w-11 shrink-0 cursor-pointer items-center justify-center rounded-full focus-visible:outline-none"
        >
          <span
            aria-hidden
            className="flex h-6 items-center rounded-full border border-[var(--line)] bg-[var(--soft)] px-[9px] text-[11px] text-[var(--ink)] group-focus-visible:shadow-[0_0_0_2px_#ef6b3f]"
          >
            <Icons.MoreHorizontal aria-hidden size={14} />
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64 max-w-[calc(100vw-1rem)]">
        {status !== undefined && (
          <>
            <div
              className="flex flex-wrap items-center gap-2 px-[10px] py-1.5"
              data-testid="topbar-menu-status"
            >
              {status}
            </div>
            <DropdownMenuSeparator />
          </>
        )}
        {projectId !== undefined && <MenuLink to={`/projects/${projectId}/runs`} label="Runs" />}
        <MenuLink to="/usage" label="Usage" />
        <MenuLink to="/guardrails" label="Guardrail policies" />
        {/* the settings gear's links (D338): no gear floats over a phone screen with this bar */}
        <MenuLink to="/providers" label="Providers" />
        <MenuLink to="/onboarding" label="Onboarding" />
        <MenuLink to="/settings" label="Settings" />
        <MenuLink to="/help/getting-started" label="Help" />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MenuLink({ to, label }: { to: string; label: string }) {
  return (
    <DropdownMenuItem
      asChild
      className="min-h-11 text-[var(--ink)] no-underline hover:text-[var(--ink)]"
    >
      <Link to={to}>{label}</Link>
    </DropdownMenuItem>
  );
}
