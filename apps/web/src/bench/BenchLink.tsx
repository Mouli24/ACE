import { Link } from 'react-router-dom';

/** The site header's way to ACE Bench (PG-5.6): a quiet text link before the theme toggle. */
export function BenchLink() {
  return (
    <Link
      to="/bench"
      data-testid="header-bench"
      className="rounded-[4px] px-1 text-[12px] font-semibold text-[var(--muted)] no-underline hover:text-[var(--ink)] focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_var(--focus)]"
    >
      Bench
    </Link>
  );
}
