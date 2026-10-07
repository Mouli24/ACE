import {
  DOCKER_SANDBOX_MODES,
  SettingsPatchSchema,
  THEMES,
  type DockerSandboxMode,
  type SettingsPatch,
  type Theme,
} from '@ace/contracts';
import {
  Button,
  Checkbox,
  Input,
  Label,
  ProviderStatusChip,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from '@ace/ui';
import { Copy } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { useProviders } from '../providers/hooks';
import { HealthMetricsPanel } from '../usage/HealthMetricsPanel';
import { ApprovalModeSection } from './ApprovalModeSection';
import { BackupSection } from './BackupSection';
import { BudgetFields } from './BudgetFields';
import { usePatchSettings, useSettings } from './hooks';
import { SecretsSection } from './secrets/SecretsSection';
import { SettingInput, type DraftRead } from './SettingFields';

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
    <section className="flex flex-col gap-4" data-testid={testId}>
      <h2 className="font-human text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function SelectField<T extends string>({
  id,
  label,
  hint,
  testId,
  value,
  options,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  hint?: string;
  testId: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select
        value={value}
        onValueChange={(next) => {
          const option = options.find((candidate) => candidate.value === next);
          if (option !== undefined && option.value !== value) onChange(option.value);
        }}
        disabled={disabled}
      >
        <SelectTrigger id={id} className="w-full sm:w-64" data-testid={testId}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {hint && <p className="text-xs text-fg-muted">{hint}</p>}
    </div>
  );
}

/**
 * `/settings` (FR-SYS-005, FR-SYS-012, FR-PRV-004, FR-GRD-008, FR-OBS-007, ACE parity D270 — the
 * approval mode, D274 — secrets): the engine's settings,
 * each saved on its own as it changes, checked by the contract before it is sent and shown back as
 * the engine holds it. Then provider status, the backup and the health metrics.
 */
export function SettingsPage() {
  const settings = useSettings();
  const patch = usePatchSettings();
  const providers = useProviders();
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
    <main className="mx-auto flex w-full max-w-xl flex-col gap-8 px-4 py-10">
      <h1 className="font-human text-2xl font-semibold">Settings</h1>

      <Section title="General" testId="settings-general">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="settings-data-dir">Data folder</Label>
          <div className="flex gap-2">
            <Input
              id="settings-data-dir"
              readOnly
              value={data?.dataDir ?? ''}
              data-testid="settings-data-dir"
              className="min-w-0 flex-1 font-machine"
            />
            <Button
              variant="outline"
              size="icon"
              aria-label="Copy data folder path"
              onClick={copyDataDir}
              disabled={disabled}
            >
              <Copy className="h-4 w-4" />
            </Button>
          </div>
          <p className="text-xs text-fg-muted">
            Where the database, artifacts and logs live. Set when the engine starts.
          </p>
        </div>

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
          value={data?.theme ?? 'dark'}
          options={THEMES.map((theme) => ({ value: theme, label: theme }))}
          onChange={(theme) => void save({ theme })}
          disabled={disabled}
        />
      </Section>

      <Section title="Runs & budget" testId="settings-runs">
        <BudgetFields
          fields="daily"
          dailyBudgetUsd={data?.dailyBudgetUsd}
          maxCostPerRunUsd={undefined}
          onSaveDailyBudget={(dailyBudgetUsd) => void save({ dailyBudgetUsd })}
          onSaveMaxCostPerRun={() => undefined}
          disabled={disabled}
        />
      </Section>

      <ApprovalModeSection
        value={data?.approvalMode}
        disabled={disabled}
        onChange={(approvalMode) => void save({ approvalMode })}
      />

      <SecretsSection />

      <Section title="Uploads & tools" testId="settings-uploads-tools">
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
        <div className="flex items-center gap-2">
          <Checkbox
            id="settings-mcp"
            data-testid="settings-mcp"
            checked={data?.mcpEnabled ?? true}
            onCheckedChange={(checked) => void save({ mcpEnabled: checked === true })}
            disabled={disabled}
          />
          <Label htmlFor="settings-mcp">Allow MCP servers</Label>
        </div>
      </Section>

      <Section title="Privacy" testId="settings-privacy">
        <p className="text-xs text-fg-muted">
          Telemetry is off. ACE ships no telemetry code, so nothing about your work leaves this
          machine except the calls you make to model providers.
        </p>
      </Section>

      <BackupSection />

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
