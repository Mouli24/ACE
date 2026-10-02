import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@ace/ui';
import { BarChart3, CircleHelp, History, Menu, Settings, ShieldCheck } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

/**
 * The top bar's links at phone width (FR-MOB-001): the same four destinations as the desktop icon
 * row — Usage, Guardrail policies, Settings, Help — plus the project's runs, behind one button.
 * `status` is what the desktop bar shows inline (provider status, the day's totals), shown at the
 * top of the menu instead of squeezed into a 380 px bar.
 */
export function CompactMenu({ projectId, status }: { projectId?: string; status?: ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Menu"
          data-testid="topbar-menu"
          className="min-h-11 min-w-11 shrink-0"
        >
          <Menu className="h-5 w-5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64 max-w-[calc(100vw-1rem)]">
        {status !== undefined && (
          <>
            <div
              className="flex flex-wrap items-center gap-2 px-2 py-1.5"
              data-testid="topbar-menu-status"
            >
              {status}
            </div>
            <DropdownMenuSeparator />
          </>
        )}
        {projectId !== undefined && (
          <MenuLink
            to={`/projects/${projectId}/runs`}
            label="Runs"
            icon={<History className="h-4 w-4" />}
          />
        )}
        <MenuLink to="/usage" label="Usage" icon={<BarChart3 className="h-4 w-4" />} />
        <MenuLink
          to="/guardrails"
          label="Guardrail policies"
          icon={<ShieldCheck className="h-4 w-4" />}
        />
        <MenuLink to="/settings" label="Settings" icon={<Settings className="h-4 w-4" />} />
        <MenuLink
          to="/help/getting-started"
          label="Help"
          icon={<CircleHelp className="h-4 w-4" />}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MenuLink({ to, label, icon }: { to: string; label: string; icon: ReactNode }) {
  return (
    <DropdownMenuItem asChild className="min-h-11 gap-2">
      <Link to={to}>
        {icon}
        {label}
      </Link>
    </DropdownMenuItem>
  );
}
