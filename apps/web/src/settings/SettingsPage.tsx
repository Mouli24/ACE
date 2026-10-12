import {
  DOCKER_SANDBOX_MODES,
  SettingsPatchSchema,
  type DockerSandboxMode,
  type SettingsPatch,
  type Theme,
} from '@ace/contracts';
import { Input, ProviderStatusChip, toast } from '@ace/ui';
import { useId, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { useProviders } from '../providers/hooks';
import { useThemeMode } from '../theme/mode';
import { Toggle } from '../theme/primitives';
import { HealthMetricsPanel } from '../usage/HealthMetricsPanel';
import { BackupSection } from './BackupSection';
import { BudgetFields } from './BudgetFields';
import { usePatchSettings, useSettings } from './hooks';
import { HELP_CLASS, SelectField, SettingField, SettingInput, type DraftRead } from './SettingFields';

/** Each box is checked by the contract's own field schema (FR-SYS-005), never a copy of its bounds. */
const fields = SettingsPatchSchema.shape;

function readWholeNumber(
  raw: string,
  schema: typeof fields.concurrency | typeof fields.maxUploadMb,
  message: string,
): DraftRead<number> {
  if (raw.trim() === '') return { error: message };
  const parsed = schema.safeParse(Number(raw));
  return parsed.success && parsed.data !== undefined ? { value: parsed.data } : { error: message };
}

export const readConcurrency = (raw: string) =>
  readWholeNumber(raw, fields.concurrency, 'Must be a whole number from 1 to 64.');

export const readUploadLimit = (raw: string) =>
  readWholeNumber(raw, fields.maxUploadMb, 'Must be a whole number of at least 1.');

/**
 * A SearXNG URL. A blank box while none is set is nothing to save; a blank box over a saved URL
 * cannot be sent, because `SettingsPatch.searxngUrl` is not nullable and a PATCH that leaves the
 * key out keeps it.
 */
export function readSearxngUrl(raw: string, current: string | undefined): DraftRead<string> {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return current === undefined
      ? { skip: true }
      : { error: 'The engine cannot clear this yet; enter another URL instead.' };
  }
  const parsed = fields.searxngUrl.safeParse(trimmed);
  return parsed.success && parsed.data !== undefined
    ? { value: parsed.data }
    : { error: 'Must be a full URL, like http://localhost:8080.' };
}

const NO_PROVIDER = '__none__';

/** The theme select's three choices (D329), in its order. */
const THEME_OPTIONS: readonly { value: Theme; label: string }[] = [
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
  { value: 'system', label: 'System' },
];

/** The theme's grid of fields: columns of at least 220px, 20px between rows, 16px between columns. */
const FIELD_GRID = 'grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-x-4 gap-y-5';

/** A settings group as a theme card: surface, hairline, radius 12, a 14px/700 title. */
function Section({
  title,
  testId,
  children,
}: {
  title: string;
  testId: string;
  children: ReactNode;
}) {
  return (
    <section
      className="flex flex-col gap-4 rounded-[12px] border border-[var(--line)] bg-[var(--surface)] p-4"
      data-testid={testId}
    >
      <h2 className="text-[14px] font-bold">{title}</h2>
      {children}
    </section>
  );
}

/**
 * The theme's switch row (its Skills list): a title and a line of help beside the 30×18 track. The
 * row is the control, `role="switch"`.
 */
function SwitchRow({
  title,
  description,
  testId,
  checked,
  onChange,
  disabled,
}: {
  title: string;
  description: string;
  testId: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled: boolean;
}) {
  const titleId = useId();
  const descriptionId = useId();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      data-testid={testId}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="flex cursor-pointer items-center gap-[10px] rounded-[9px] border border-[var(--line)] bg-transparent px-3 py-[10px] text-left text-[var(--ink)] outline-none hover:bg-[var(--hover)] focus-visible:border-[#ef6b3f] disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span className="min-w-0 flex-1">
        <span id={titleId} className="block text-[12.5px] font-semibold">
          {title}
        </span>
        <span id={descriptionId} className="mt-px block text-[10.5px] text-[var(--muted)]">
          {description}
        </span>
      </span>
      <Toggle on={checked} />
    </button>
  );
}

/**
 * `/settings` (FR-SYS-005, FR-SYS-012, FR-PRV-004, FR-GRD-008, FR-OBS-007): the engine's settings,
 * each saved on its own as it changes, checked by the contract before it is sent and shown back as
 * the engine holds it. Then provider status, the backup and the health metrics. Restyled as theme
 * cards and fields (D328); the theme select is the browser's choice (D329).
 */
export function SettingsPage() {
  const settings = useSettings();
  const patch = usePatchSettings();
  const providers = useProviders();
  const themeMode = useThemeMode();
  const data = settings.data;
  const disabled = data === undefined;

  /** Saves one change; resolves whether the engine took it, after toasting either way. */
  const save = (change: SettingsPatch): Promise<boolean> =>
    patch.mutateAsync(change).then(
      () => {
        toast.success('Settings saved');
        return true;
      },
      (error: unknown) => {
        toast.error('Settings not saved', {
          description: error instanceof Error ? error.message : undefined,
        });
        return false;
      },
    );

  /**
   * D329: the screen follows `ace-theme` in this browser, applied at once; the engine's
   * `Settings.theme` is still patched so the choice is recorded there as before.
   */
  const pickTheme = (theme: Theme) => {
    themeMode.setMode(theme);
    void save({ theme });
  };

  const copyDataDir = () => {
    if (data === undefined) return;
    void navigator.clipboard?.writeText(data.dataDir).then(
      () => toast.success('Data folder path copied'),
      () => toast.error('Could not copy the path'),
    );
  };

  const providerOptions = [
    // `defaultProviderId` cannot be cleared through a PATCH, so "none" is offered only while none is set.
    ...(data?.defaultProviderId === undefined ? [{ value: NO_PROVIDER, label: 'none' }] : []),
    ...(providers.data ?? []).map((provider) => ({ value: provider.id, label: provider.name })),
  ];

  return (
    <main className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[960px] flex-col gap-6 px-6 py-8">
        <h1 className="text-[20px] font-bold tracking-[-0.01em]">Settings</h1>

        <Section title="General" testId="settings-general">
          <SettingField
            label="Data folder"
            htmlFor="settings-data-dir"
            hint="Where the database, artifacts and logs live. Set when the engine starts."
          >
            {/* The theme's in-field button, as on its API key input. */}
            <div className="relative">
              <Input
                id="settings-data-dir"
                readOnly
                value={data?.dataDir ?? ''}
                data-testid="settings-data-dir"
                className="pr-16 font-machine text-[12px]"
              />
              <button
                type="button"
                aria-label="Copy data folder path"
                onClick={copyDataDir}
                disabled={disabled}
                className="absolute right-[6px] top-[6px] h-[26px] cursor-pointer rounded-[7px] border border-[var(--line)] bg-[var(--surface)] px-[10px] text-[11px] font-semibold text-[var(--muted)] outline-none hover:bg-[var(--hover)] focus-visible:border-[#ef6b3f] disabled:cursor-not-allowed disabled:opacity-50"
              >
                Copy
              </button>
            </div>
          </SettingField>

          <div className={FIELD_GRID}>
            <SelectField
              id="settings-default-provider"
              label="Default provider"
              hint="Used by new agents that do not name one."
              testId="settings-default-provider"
              value={data?.defaultProviderId ?? NO_PROVIDER}
              options={providerOptions}
              onChange={(value) => {
                if (value !== NO_PROVIDER) void save({ defaultProviderId: value });
              }}
              disabled={disabled}
            />

            <SettingInput
              label="Concurrency"
              hint="How many node runs may execute at once, 1 to 64."
              testId="settings-concurrency"
              value={data?.concurrency}
              read={readConcurrency}
              onSave={(concurrency) => save({ concurrency })}
              disabled={disabled}
              numeric
            />

            <SelectField<Theme>
              id="theme"
              label="Theme"
              testId="settings-theme"
              value={themeMode.mode}
              options={THEME_OPTIONS}
              onChange={pickTheme}
              disabled={false}
            />
          </div>
        </Section>

        <section
          className="flex flex-col gap-4 rounded-[12px] border border-[var(--line)] bg-[var(--surface)] p-4"
          data-testid="settings-runs"
        >
          <BudgetFields
            fields="daily"
            dailyBudgetUsd={data?.dailyBudgetUsd}
            maxCostPerRunUsd={undefined}
            onSaveDailyBudget={(dailyBudgetUsd) => void save({ dailyBudgetUsd })}
            onSaveMaxCostPerRun={() => undefined}
            disabled={disabled}
          />
        </section>

        <Section title="Uploads & tools" testId="settings-uploads-tools">
          <div className={FIELD_GRID}>
            <SettingInput
              label="Upload limit (MB)"
              hint="A larger file is refused when it is uploaded."
              testId="settings-upload-limit"
              value={data?.maxUploadMb}
              read={readUploadLimit}
              onSave={(maxUploadMb) => save({ maxUploadMb })}
              disabled={disabled}
              numeric
            />
            <SettingInput
              label="SearXNG URL"
              hint="Your own SearXNG instance for web search. Blank means no search tool."
              testId="settings-searxng"
              value={data?.searxngUrl}
              read={(raw) => readSearxngUrl(raw, data?.searxngUrl)}
              onSave={(searxngUrl) => save({ searxngUrl })}
              disabled={disabled}
              placeholder="http://localhost:8080"
            />
            <SelectField<DockerSandboxMode>
              id="settings-docker"
              label="Docker sandbox"
              hint="auto uses Docker when it is available and a limited child process otherwise."
              testId="settings-docker"
              value={data?.dockerSandbox ?? 'auto'}
              options={DOCKER_SANDBOX_MODES.map((mode) => ({ value: mode, label: mode }))}
              onChange={(dockerSandbox) => void save({ dockerSandbox })}
              disabled={disabled}
            />
          </div>
          <SwitchRow
            title="Allow MCP servers"
            description="Whether MCP servers may be connected at all."
            testId="settings-mcp"
            checked={data?.mcpEnabled ?? true}
            onChange={(mcpEnabled) => void save({ mcpEnabled })}
            disabled={disabled}
          />
        </Section>

        <Section title="Privacy" testId="settings-privacy">
          <p className={HELP_CLASS}>
            Telemetry is off. ACE ships no telemetry code, so nothing about your work leaves this
            machine except the calls you make to model providers.
          </p>
        </Section>

        <BackupSection />

        <Section title="Providers" testId="settings-providers">
          {providers.data?.length === 0 ? (
            <p className={HELP_CLASS}>
              None yet — <Link to="/providers">add one</Link>.
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
          <Link to="/providers" className="self-start text-[12px] font-semibold">
            Manage providers and models
          </Link>
        </Section>

        <HealthMetricsPanel />
      </div>
    </main>
  );
}
