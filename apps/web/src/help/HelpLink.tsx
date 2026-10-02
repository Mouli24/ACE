import { CircleHelp } from 'lucide-react';
import { Link } from 'react-router-dom';

/** A link into the bundled user guide (FR-ONB-003); `page` is a `docs/user-guide` file name. */
export function HelpLink({ page, children }: { page: string; children: string }) {
  return (
    <Link
      to={`/help/${page}`}
      data-testid={`help-link-${page}`}
      className="inline-flex items-center gap-1 rounded-sm font-human text-xs text-fg-muted underline-offset-2 hover:text-fg hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <CircleHelp aria-hidden className="h-3.5 w-3.5" />
      {children}
    </Link>
  );
}
