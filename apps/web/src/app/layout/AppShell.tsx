import { Toaster, TooltipProvider } from '@ace/ui';
import type { ReactNode } from 'react';
import { Outlet, useMatch, useParams } from 'react-router-dom';

import { useBeforeUnloadGuard } from '../../forge/editor/guards';
import { useWorkflowMode } from '../../forge/mode';
import { useIsCompact } from '../../responsive/useIsCompact';
import { useThemeMode } from '../../theme/mode';
import { useApplyTheme } from '../theme';
import { CompactTopBar } from './CompactTopBar';
import { SettingsMenu } from './SettingsMenu';
import { SiteHeader } from './SiteHeader';
import { WorkspaceFooter } from './WorkspaceFooter';
import { WorkspaceHeader } from './WorkspaceHeader';

const ROOT = 'flex h-screen flex-col overflow-hidden bg-[var(--canvas)] text-[var(--ink)]';
const SCROLL = 'min-h-0 flex-1 overflow-auto';

/**
 * Root layout (D330). Ideate, Forge and Domain get the theme's workspace header and footer around
 * the routed screen; Home draws its own header; every other route gets Home's header with a
 * section label. At phone width every route but Home (which keeps its own header) gets the compact
 * bar, and there is no footer.
 *
 * The settings gear (D338) sits in the bottom-left corner: in the workspace footer, floating where
 * there is none. The phone bar's menu carries its links instead, so nothing floats over a phone
 * screen's own controls — except on Home, which has no such bar.
 */
export function AppShell() {
  useApplyTheme();
  useBeforeUnloadGuard();
  const { dark } = useThemeMode();
  return (
    <TooltipProvider delayDuration={200}>
      <Chrome />
      <Toaster theme={dark ? 'dark' : 'light'} />
    </TooltipProvider>
  );
}

function Chrome() {
  const { projectId, workflowId } = useParams();
  const mode = useWorkflowMode();
  const compact = useIsCompact();
  const home = useMatch('/projects') !== null;
  const outlet = <Outlet />;

  if (compact) {
    return (
      <Root>
        {!home && <CompactTopBar />}
        <div className={SCROLL}>{outlet}</div>
        {home && <SettingsMenu placement="corner" />}
      </Root>
    );
  }
  if (mode !== undefined && projectId !== undefined && workflowId !== undefined) {
    return (
      <Root>
        <WorkspaceHeader projectId={projectId} workflowId={workflowId} mode={mode} />
        {/* the routed screen fills the row, whatever its own root says */}
        <main className="flex min-h-0 flex-1 *:min-w-0 *:flex-1">{outlet}</main>
        <WorkspaceFooter projectId={projectId} workflowId={workflowId} mode={mode} />
      </Root>
    );
  }
  return (
    <Root>
      {!home && <SiteHeader />}
      <div className={SCROLL}>{outlet}</div>
      <SettingsMenu placement="corner" />
    </Root>
  );
}

function Root({ children }: { children: ReactNode }) {
  return <div className={ROOT}>{children}</div>;
}
