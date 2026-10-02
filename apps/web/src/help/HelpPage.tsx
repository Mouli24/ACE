import { Markdown } from '@ace/ui';
import { useMemo, type MouseEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { GUIDE_PAGES, guidePage, prepareGuideMarkdown } from './guide';

/**
 * `/help/:page` — the bundled user guide (FR-ONB-003, D240): an index of every page beside the one
 * asked for, rendered with `@ace/ui`'s `Markdown`. Nothing is fetched, so it works offline.
 */
export function HelpPage() {
  const { page: slug } = useParams();
  const navigate = useNavigate();
  const page = guidePage(slug);
  const origin = window.location.origin;
  const markdown = useMemo(
    () => (page ? prepareGuideMarkdown(page.markdown, origin) : ''),
    [page, origin],
  );

  /** A link to another guide page opens here, not in a new tab (they are absolute only for `Markdown`). */
  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    const anchor = (event.target as HTMLElement).closest('a');
    const href = anchor?.getAttribute('href') ?? '';
    const prefix = `${origin}/help/`;
    if (!href.startsWith(prefix)) return;
    event.preventDefault();
    navigate(href.slice(origin.length));
  };

  return (
    <main
      data-testid="help-page"
      className="mx-auto flex h-full w-full max-w-5xl flex-col gap-6 overflow-y-auto p-4 sm:flex-row sm:p-6"
    >
      <nav aria-label="User guide" className="shrink-0 sm:w-56">
        <h2 className="mb-2 font-machine text-[10px] uppercase tracking-wider text-fg-muted">
          User guide
        </h2>
        <ul className="flex flex-col gap-0.5" data-testid="help-index">
          {GUIDE_PAGES.map((entry) => (
            <li key={entry.slug}>
              <Link
                to={`/help/${entry.slug}`}
                aria-current={entry.slug === slug ? 'page' : undefined}
                className="block rounded-md px-2 py-1 font-human text-sm text-fg-muted hover:bg-card hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent aria-[current=page]:bg-card aria-[current=page]:text-fg"
              >
                {entry.title}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      <article className="min-w-0 flex-1" data-testid="help-article" data-page={page?.slug}>
        {page ? (
          // The clicks are on the links inside, which are focusable and fire click on Enter.
          <div onClick={onClick}>
            <Markdown text={markdown} className="max-w-prose" />
          </div>
        ) : (
          <div role="alert" data-testid="help-not-found" className="flex flex-col gap-2">
            <h1 className="font-human text-lg font-semibold">No help page called “{slug}”</h1>
            <p className="font-human text-sm text-fg-muted">
              Pick a page from the list, or start with{' '}
              <Link to="/help/getting-started" className="text-accent underline">
                Getting started
              </Link>
              .
            </p>
          </div>
        )}
      </article>
    </main>
  );
}
