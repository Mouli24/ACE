import { Toaster, TooltipProvider } from '@ace/ui';
import { Outlet } from 'react-router-dom';

import { useApplyTheme } from '../theme';
import { TopBar } from './TopBar';

/** Root layout: top bar over the routed screen (Arch §33.1 step 5 puts the panes inside). */
export function AppShell() {
  useApplyTheme();
  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex h-full flex-col bg-canvas text-fg">
        <TopBar />
        <div className="min-h-0 flex-1">
          <Outlet />
        </div>
      </div>
      <Toaster />
    </TooltipProvider>
  );
}
