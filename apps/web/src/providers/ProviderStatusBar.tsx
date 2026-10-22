import { ProviderStatusChip } from '@ace/ui';
import { Link } from 'react-router-dom';

import { useProviders } from './hooks';

const VISIBLE = 4;

/**
 * Narrow bars show each provider as its dot: the name and state (every span after the dot) stay in
 * the DOM for screen readers and in the chip's title for a pointer. One provider keeps its full
 * chip from xl up, as the design shows it; two or more stay dots up to 2xl, so a full set of long
 * names cannot push the top bar wider than the page.
 */
const DOT_BELOW_XL =
  'max-xl:gap-0 max-xl:border-transparent max-xl:bg-transparent max-xl:px-0.5 max-xl:[&>span+span]:sr-only';
const DOT_BELOW_2XL =
  'max-2xl:gap-0 max-2xl:border-transparent max-2xl:bg-transparent max-2xl:px-0.5 max-2xl:[&>span+span]:sr-only';

/**
 * Provider status in the phone header's menu (FR-PRV-004, TC-PRV-005); wider screens see it on
 * the Providers page (D330). It reads the same providers query the
 * screen does, and that query is patched by `provider.status` frames, so a status change shows here
 * without a reload and without this component subscribing to anything itself.
 */
export function ProviderStatusBar() {
  const providers = useProviders();
  const items = providers.data ?? [];

  if (items.length === 0) {
    return (
      <Link
        to="/providers"
        className="shrink-0 rounded-full border border-dashed border-[var(--iconLine)] px-2.5 py-1 font-machine text-[10.5px] text-[var(--muted)] no-underline hover:text-[var(--ink)]"
      >
        no providers
      </Link>
    );
  }

  const shown = items.slice(0, VISIBLE);
  const hidden = items.length - shown.length;

  return (
    <Link
      to="/providers"
      className="flex shrink-0 items-center gap-1 rounded-full text-[var(--ink)] no-underline hover:text-[var(--ink)] focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_var(--focus)] xl:gap-1.5"
      aria-label="Providers"
      data-testid="provider-status-bar"
    >
      {shown.map((provider) => (
        <ProviderStatusChip
          key={provider.id}
          data-testid={`provider-status-${provider.id}`}
          className={shown.length > 1 ? DOT_BELOW_2XL : DOT_BELOW_XL}
          name={provider.name}
          status={provider.status}
          {...(provider.statusMessage === undefined ? {} : { message: provider.statusMessage })}
          {...(provider.lastCheckedAt === undefined
            ? {}
            : { lastCheckedAt: provider.lastCheckedAt })}
        />
      ))}
      {hidden > 0 && (
        <span className="font-machine text-[10.5px] text-[var(--muted)]">+{hidden}</span>
      )}
    </Link>
  );
}
