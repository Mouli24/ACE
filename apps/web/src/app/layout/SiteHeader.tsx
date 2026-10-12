import { Link, useLocation } from 'react-router-dom';

import { LogoMark, ThemeToggle } from '../../theme/primitives';

/**
 * Small-caps section labels by route, most specific first. A workflow's other routes (the
 * timeline) come before the project's own page, which matches any `/projects/:id`.
 */
const SECTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^\/projects\/[^/]+\/workflows\/[^/]+\/timeline\/?$/, 'TIMELINE'],
  [/^\/projects\/[^/]+\/workflows\//, 'WORKFLOW'],
  [/^\/projects\/[^/]+\/runs\/?$/, 'RUNS'],
  [/^\/projects\/[^/]+\/knowledge\/?$/, 'KNOWLEDGE'],
  [/^\/projects\/[^/]+\/?$/, 'PROJECT'],
  [/^\/projects\/?$/, 'HOME'],
  [/^\/knowledge\//, 'KNOWLEDGE'],
  [/^\/runs\//, 'RUN'],
  [/^\/providers\/?/, 'PROVIDERS'],
  [/^\/guardrails\/?/, 'GUARDRAILS'],
  [/^\/library\/tools\/?/, 'TOOLS'],
  [/^\/usage\/?/, 'USAGE'],
  [/^\/settings\/?/, 'SETTINGS'],
  [/^\/help\//, 'HELP'],
  [/^\/onboarding\/?/, 'ONBOARDING'],
];

/** The section label for a path, or undefined where none applies (`/` redirects). */
export function sectionLabel(pathname: string): string | undefined {
  return SECTIONS.find(([pattern]) => pattern.test(pathname))?.[1];
}

/**
 * Home's header (`Ace Home.dc.html`) on every route outside the workspace and Home itself (D330):
 * the mark and ACE (to Home), the route's small-caps section label, and the theme toggle.
 */
export function SiteHeader() {
  const { pathname } = useLocation();
  const label = sectionLabel(pathname);
  return (
    <header className="sticky top-0 z-10 flex h-[44px] shrink-0 items-center gap-[10px] bg-[var(--hdr)] px-9 shadow-[0_1px_0_var(--line)] backdrop-blur-[10px]">
      <Link
        to="/projects"
        className="flex items-center gap-[10px] rounded-[4px] text-[var(--ink)] no-underline hover:text-[var(--ink)] focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_#ef6b3f]"
      >
        <LogoMark size={14} />
        <span className="text-[15px] font-bold tracking-[0.02em]">ACE</span>
      </Link>
      {label && (
        <div
          data-testid="section-label"
          className="text-[9px] font-semibold uppercase tracking-[0.12em] text-[var(--muted)]"
        >
          {label}
        </div>
      )}
      <div className="flex-1" />
      <ThemeToggle variant="home" />
    </header>
  );
}
