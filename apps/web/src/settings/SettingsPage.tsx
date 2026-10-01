import { THEMES, type Theme } from '@ace/contracts';
import {
  Label,
  ProviderStatusChip,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@ace/ui';
import { Link } from 'react-router-dom';

import { useProviders } from '../providers/hooks';
import { HealthMetricsPanel } from '../usage/HealthMetricsPanel';
import { BudgetFields } from './BudgetFields';
import { usePatchSettings, useSettings } from './hooks';

/**
 * `/settings` — the theme, the daily spending cap and provider status (FR-PRV-004, FR-GRD-008).
 *
 * The chips read the same providers query the top bar does, patched by `provider.status`, so all
 * three places agree without a reload. The per-run cap belongs to a project, so it is on the project
 * page rather than here.
 */
export function SettingsPage() {
  const settings = useSettings();
  const patch = usePatchSettings();
  const providers = useProviders();

  return (
    <main className="mx-auto flex w-full max-w-xl flex-col gap-6 px-4 py-10">
      <h1 className="font-human text-2xl font-semibold">Settings</h1>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="theme">Theme</Label>
        <Select
          value={settings.data?.theme ?? 'dark'}
          onValueChange={(value) => patch.mutate({ theme: value as Theme })}
          disabled={!settings.data}
        >
          <SelectTrigger id="theme" className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {THEMES.map((theme) => (
              <SelectItem key={theme} value={theme}>
                {theme}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-fg-muted">
          Light and system themes render in a later round; dark is the design.
        </p>
      </div>

      <BudgetFields
        fields="daily"
        dailyBudgetUsd={settings.data?.dailyBudgetUsd}
        maxCostPerRunUsd={undefined}
        onSaveDailyBudget={(dailyBudgetUsd) => patch.mutate({ dailyBudgetUsd })}
        onSaveMaxCostPerRun={() => undefined}
        disabled={!settings.data}
      />

      <section className="flex flex-col gap-2" data-testid="settings-providers">
        <h2 className="font-human text-sm font-semibold">Providers</h2>
        {providers.data?.length === 0 ? (
          <p className="text-xs text-fg-muted">
            None yet —{' '}
            <Link to="/providers" className="underline">
              add one
            </Link>
            .
          </p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {providers.data?.map((provider) => (
              <li key={provider.id}>
                <ProviderStatusChip
                  data-testid={`provider-status-${provider.id}`}
                  name={provider.name}
                  status={provider.status}
                  {...(provider.statusMessage === undefined
                    ? {}
                    : { message: provider.statusMessage })}
                  {...(provider.lastCheckedAt === undefined
                    ? {}
                    : { lastCheckedAt: provider.lastCheckedAt })}
                />
              </li>
            ))}
          </ul>
        )}
        <Link to="/providers" className="font-machine text-xs underline">
          manage providers and models
        </Link>
      </section>
      <HealthMetricsPanel />
    </main>
  );
}
