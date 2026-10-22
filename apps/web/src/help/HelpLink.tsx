import { Link } from 'react-router-dom';

/**
 * A link into the bundled user guide (FR-ONB-003); `page` is a `docs/user-guide` file name. In the
 * theme's help-text style (11px, muted), ink on hover (D328).
 */
export function HelpLink({ page, children }: { page: string; children: string }) {
  return (
    <Link
      to={`/help/${page}`}
      data-testid={`help-link-${page}`}
      className="inline-flex items-center rounded-[4px] text-[11px] font-semibold text-[var(--muted)] underline-offset-2 outline-none hover:text-[var(--ink)] hover:underline focus-visible:shadow-[0_0_0_2px_var(--focus)]"
    >
      {children}
    </Link>
  );
}
