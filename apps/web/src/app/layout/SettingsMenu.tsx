import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Icons,
  cn,
} from '@ace/ui';
import { Link } from 'react-router-dom';

import { APP_LINKS } from './app-links';

const TRIGGER: Readonly<Record<'footer' | 'corner', string>> = {
  // the 24px workspace footer, before the connection status
  footer:
    'h-[18px] w-[18px] border-[var(--line)] bg-[var(--soft)] text-[11px] text-[var(--muted)] hover:text-[var(--ink)]',
  // floating in the window's bottom-left corner where there is no footer, like the Add node pill
  corner:
    'fixed bottom-[16px] left-[16px] z-[20] h-[34px] w-[34px] border-[var(--line)] bg-[var(--surface)] text-[15px] text-[var(--ink)] shadow-[0_10px_26px_-14px_rgba(40,25,15,0.45)] hover:border-[#ef6b3f]',
};

/**
 * The settings gear in the bottom-left corner (D338): in the workspace footer on Ideate, Forge and
 * Domain, floating in the corner everywhere else. Its menu opens upward on the app's pages (audit
 * U-7: every one of them, from any screen — the setup wizard among them, which is otherwise reached
 * only by a brand-new user's first visit).
 */
export function SettingsMenu({ placement }: { placement: 'footer' | 'corner' }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Settings menu"
          title="Settings"
          data-testid="settings-menu"
          data-placement={placement}
          className={cn(
            'flex shrink-0 cursor-pointer items-center justify-center rounded-full border p-0 leading-none focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_#ef6b3f]',
            TRIGGER[placement],
          )}
        >
          <Icons.Settings aria-hidden size={placement === 'corner' ? 16 : 11} strokeWidth={2} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" sideOffset={6} collisionPadding={8}>
        {APP_LINKS.map(({ to, label, id }) => (
          <DropdownMenuItem
            key={to}
            asChild
            data-testid={`settings-menu-${id}`}
            className="text-[var(--ink)] no-underline hover:text-[var(--ink)]"
          >
            <Link to={to}>{label}</Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
