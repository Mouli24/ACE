import { ProviderStatusChip } from '@ace/ui';
import { Link } from 'react-router-dom';

import { useProviders } from './hooks';

const VISIBLE = 4;

/**
 * Provider status in the top bar (FR-PRV-004, TC-PRV-005). It reads the same providers query the
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
        className="rounded-chip border border-dashed border-border px-2 py-0.5 text-xs text-fg-muted hover:text-fg"
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
      className="flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      aria-label="Providers"
      data-testid="provider-status-bar"
    >
      {shown.map((provider) => (
        <ProviderStatusChip
          key={provider.id}
          data-testid={`provider-status-${provider.id}`}
          name={provider.name}
          status={provider.status}
          {...(provider.statusMessage === undefined ? {} : { message: provider.statusMessage })}
          {...(provider.lastCheckedAt === undefined
            ? {}
            : { lastCheckedAt: provider.lastCheckedAt })}
        />
      ))}
      {hidden > 0 && <span className="font-machine text-xs text-fg-muted">+{hidden}</span>}
    </Link>
  );
}
