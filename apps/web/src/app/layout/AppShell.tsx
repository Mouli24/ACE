import { Toaster, TooltipProvider } from '@ace/ui';
import { useEffect, type ReactNode } from 'react';
import { Outlet, useLocation, useMatch, useParams } from 'react-router-dom';

import { useBeforeUnloadGuard } from '../../forge/editor/guards';
import { useWorkflowMode } from '../../forge/mode';
import { useIsCompact } from '../../responsive/useIsCompact';
import { useThemeMode } from '../../theme/mode';
import { TokenMissing } from '../TokenMissing';
import { useSessionStore } from '../stores/session';
import { useApplyTheme } from '../theme';
import { CompactTopBar } from './CompactTopBar';
import { SettingsMenu } from './SettingsMenu';
import { SiteHeader, documentTitle } from './SiteHeader';
import { WorkspaceFooter } from './WorkspaceFooter';
import { WorkspaceHeader } from './WorkspaceHeader';

const ROOT = 'flex h-screen flex-col overflow-hidden bg-[var(--canvas)] text-[var(--ink)]';
const SCROLL = 'min-h-0 flex-1 overflow-auto outline-none';
/** Where the skip link lands (audit U-13): the routed screen's container, in every chrome. */
const MAIN_ID = 'ace-main';

/**
 * Root layout (D330). Ideate, Forge and Domain get the theme's workspace header and footer around
 * the routed screen; Home draws its own header; every other route gets Home's header with a
 * section label. At phone width every route but Home (which keeps its own header) gets the compact
 * bar, and there is no footer.
 *
 * The settings gear (D338) sits in the bottom-left corner: in the workspace footer, floating where
 * there is none. The phone bar's menu carries its links instead, so nothing floats over a phone
 * screen's own controls — except on Home, which has no such bar.
 *
 * Audit U-2: once the engine stops taking this page's token (it restarted), the whole app gives way
 * to the session-lost screen — every screen behind it would only fail.
 *
 * Audit U-13: a skip link is the first thing a keyboard reaches, past the header to the screen, and
 * the tab names the section ("Providers · ACE", the mode inside a workflow).
 */
export function AppShell() {
  useApplyTheme();
  useBeforeUnloadGuard();
  const { dark } = useThemeMode();
  const sessionLost = useSessionStore((store) => store.lost);
  return (
    <TooltipProvider delayDuration={200}>
      {sessionLost ? (
        <Root>
          <TokenMissing expired />
        </Root>
      ) : (
        <>
          <SkipLink />
          <Chrome />
        </>
      )}
      <Toaster theme={dark ? 'dark' : 'light'} />
    </TooltipProvider>
  );
}

function Chrome() {
  const { projectId, workflowId } = useParams();
  const mode = useWorkflowMode();
  const compact = useIsCompact();
  const home = useMatch('/projects') !== null;
  const { pathname } = useLocation();
  useEffect(() => {
    document.title = documentTitle(pathname, mode);
  }, [pathname, mode]);
  const outlet = <Outlet />;

  if (compact) {
    return (
      <Root>
        {!home && <CompactTopBar />}
        <div id={MAIN_ID} tabIndex={-1} className={SCROLL}>
          {outlet}
        </div>
        {home && <SettingsMenu placement="corner" />}
      </Root>
    );
  }
  if (mode !== undefined && projectId !== undefined && workflowId !== undefined) {
    return (
      <Root>
        <WorkspaceHeader projectId={projectId} workflowId={workflowId} mode={mode} />
        {/* the routed screen fills the row, whatever its own root says */}
        <main
          id={MAIN_ID}
          tabIndex={-1}
          className="flex min-h-0 flex-1 outline-none *:min-w-0 *:flex-1"
        >
          {outlet}
        </main>
        <WorkspaceFooter projectId={projectId} workflowId={workflowId} mode={mode} />
      </Root>
    );
  }
  return (
    <Root>
      {!home && <SiteHeader />}
      <div id={MAIN_ID} tabIndex={-1} className={SCROLL}>
        {outlet}
      </div>
      <SettingsMenu placement="corner" />
    </Root>
  );
}

/** Hidden until focused; it moves focus to the screen without touching the URL's hash. */
function SkipLink() {
  return (
    <a
      href={`#${MAIN_ID}`}
      onClick={(event) => {
        event.preventDefault();
        document.getElementById(MAIN_ID)?.focus();
      }}
      className="sr-only rounded-[8px] border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-[13px] font-semibold text-[var(--ink)] focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[100] focus:shadow-[0_0_0_2px_#ef6b3f]"
    >
      Skip to content
    </a>
  );
}

function Root({ children }: { children: ReactNode }) {
  return <div className={ROOT}>{children}</div>;
}
