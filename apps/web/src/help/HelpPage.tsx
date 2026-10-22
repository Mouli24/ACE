import { FIELD_LABEL_CLASS, Markdown, cn } from '@ace/ui';
import { useMemo, type MouseEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { GUIDE_PAGES, guidePage, prepareGuideMarkdown } from './guide';

/**
 * `/help/:page` — the bundled user guide (FR-ONB-003, D240): an index of every page beside the one
 * asked for, rendered with `@ace/ui`'s `Markdown`. Nothing is fetched, so it works offline.
 *
 * In the Ace UI theme (D328) the index is a row of pills — the open page filled like the theme's
 * active segment, the others like Home's idle filter pills — over the article in a theme card.
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
    <main data-testid="help-page" className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[960px] flex-col gap-6 px-6 py-8">
        <nav aria-label="User guide" className="flex flex-col gap-[10px]">
          <h2 className={FIELD_LABEL_CLASS}>User guide</h2>
          <ul className="flex flex-wrap gap-[6px]" data-testid="help-index">
            {GUIDE_PAGES.map((entry) => (
              <li key={entry.slug}>
                <Link
                  to={`/help/${entry.slug}`}
                  aria-current={entry.slug === slug ? 'page' : undefined}
                  className={cn(
                    'flex h-[26px] items-center whitespace-nowrap rounded-full border px-[14px] text-[12px] font-semibold outline-none focus-visible:shadow-[0_0_0_2px_var(--focus)]',
                    entry.slug === slug
                      ? 'border-[var(--seg)] bg-[var(--seg)] text-[var(--segInk)] hover:text-[var(--segInk)]'
                      : 'border-[var(--pillOffLine)] bg-[var(--pillOff)] text-[var(--pillOffInk)] hover:bg-[var(--hover)] hover:text-[var(--pillOffInk)]',
                  )}
                >
                  {entry.title}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <article
          className="min-w-0 rounded-[12px] border border-[var(--line)] bg-[var(--surface)] p-5 text-[13px] leading-[1.55]"
          data-testid="help-article"
          data-page={page?.slug}
        >
          {page ? (
            // The clicks are on the links inside, which are focusable and fire click on Enter.
            <div onClick={onClick}>
              <Markdown text={markdown} className="max-w-prose" />
            </div>
          ) : (
            <div role="alert" data-testid="help-not-found" className="flex flex-col gap-2">
              <h1 className="text-[20px] font-bold tracking-[-0.01em]">
                No help page called “{slug}”
              </h1>
              <p className="text-[13px] text-[var(--muted)]">
                Pick a page from the list, or start with{' '}
                <Link to="/help/getting-started">Getting started</Link>.
              </p>
            </div>
          )}
        </article>
      </div>
    </main>
  );
}
