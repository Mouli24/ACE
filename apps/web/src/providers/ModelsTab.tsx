import {
  DATA_TYPES,
  type DataType,
  type Model,
  type ModelQuery,
  type Provider,
} from '@ace/contracts';
import {
  Button,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@ace/ui';
import { RefreshCw } from 'lucide-react';
import { useState } from 'react';

import { useModels, useRefreshModels } from './hooks';
import { PROVIDER_TYPE_LABEL, providerAccent } from './provider-meta';

const ANY = 'any';

/** `undefined` means "no filter"; the Select needs a concrete value, so `any` stands in for it. */
type Filter = { providerId: string; inputType: string; outputType: string; availability: string };

const EMPTY: Filter = {
  providerId: ANY,
  inputType: ANY,
  outputType: ANY,
  availability: ANY,
};

function toQuery(filter: Filter): ModelQuery {
  return {
    ...(filter.providerId === ANY ? {} : { providerId: filter.providerId }),
    ...(filter.inputType === ANY ? {} : { inputType: filter.inputType as DataType }),
    ...(filter.outputType === ANY ? {} : { outputType: filter.outputType as DataType }),
    ...(filter.availability === ANY ? {} : { available: filter.availability === 'available' }),
  };
}

const money = (value: number) => `$${value.toFixed(4)}`;

/**
 * The model catalog (FR-MOD-004/006, TC-MOD-003). Filtering is done by the engine — the same
 * `ModelQuery` the config panel narrows with — so the table and the model picker can never disagree
 * about what "supports image input" means (D29).
 */
export function ModelsTab({ providers }: { providers: Provider[] }) {
  const [filter, setFilter] = useState<Filter>(EMPTY);
  const models = useModels(toQuery(filter));
  const refresh = useRefreshModels();
  const [refreshedAt, setRefreshedAt] = useState<string>();
  /** D286: why the last refresh could not ask its provider — a CLI not installed or signed out. */
  const [warning, setWarning] = useState<string>();

  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  const set = (patch: Partial<Filter>) => setFilter((current) => ({ ...current, ...patch }));

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <FilterSelect
          id="model-filter-provider"
          label="Provider"
          value={filter.providerId}
          onChange={(value) => set({ providerId: value })}
          options={[
            { value: ANY, label: 'All providers' },
            ...providers.map((provider) => ({ value: provider.id, label: provider.name })),
          ]}
        />
        <FilterSelect
          id="model-filter-input"
          label="Input type"
          value={filter.inputType}
          onChange={(value) => set({ inputType: value })}
          options={[
            { value: ANY, label: 'Any input' },
            ...DATA_TYPES.map((type) => ({ value: type, label: type })),
          ]}
        />
        <FilterSelect
          id="model-filter-output"
          label="Output type"
          value={filter.outputType}
          onChange={(value) => set({ outputType: value })}
          options={[
            { value: ANY, label: 'Any output' },
            ...DATA_TYPES.map((type) => ({ value: type, label: type })),
          ]}
        />
        <FilterSelect
          id="model-filter-availability"
          label="Availability"
          value={filter.availability}
          onChange={(value) => set({ availability: value })}
          options={[
            { value: ANY, label: 'Any' },
            { value: 'available', label: 'Available' },
            { value: 'retired', label: 'Unavailable' },
          ]}
        />
        <div className="flex-1" />
        <div className="flex flex-col items-end gap-1">
          <RefreshMenu
            providers={providers}
            pending={refresh.isPending}
            onRefresh={(providerId) =>
              refresh.mutate(providerId, {
                onSuccess: (result) => {
                  setRefreshedAt(result.refreshedAt);
                  setWarning(result.warning);
                },
                onError: (error) => setWarning(error.message),
              })
            }
          />
          <p className="font-machine text-xs text-fg-muted" data-testid="models-refreshed-at">
            refreshed{' '}
            {new Date(refreshedAt ?? models.data?.refreshedAt ?? Date.now()).toLocaleTimeString()}
          </p>
        </div>
      </div>

      {warning !== undefined && (
        <p
          role="alert"
          data-testid="models-refresh-warning"
          className="rounded-card border border-danger/50 bg-danger/5 px-3 py-2 text-sm text-fg"
        >
          The provider could not list its models: {warning}
        </p>
      )}

      {models.isError && (
        <p role="alert" className="text-danger">
          Could not load models: {models.error.message}
        </p>
      )}
      {models.data?.items.length === 0 && (
        <p className="rounded-card border border-dashed border-border p-8 text-center text-fg-muted">
          No model matches these filters.
        </p>
      )}

      {(models.data?.items.length ?? 0) > 0 && (
        <table className="w-full border-collapse text-sm" data-testid="models-table">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase text-fg-muted">
              <th className="py-2 pr-3 font-normal">Provider</th>
              <th className="py-2 pr-3 font-normal">Model</th>
              <th className="py-2 pr-3 font-normal">In → out</th>
              <th className="py-2 pr-3 font-normal">Context</th>
              <th className="py-2 pr-3 font-normal">Tools / JSON</th>
              <th className="py-2 pr-3 font-normal">Source</th>
              <th className="py-2 pr-3 font-normal">Price / 1k</th>
            </tr>
          </thead>
          <tbody>
            {models.data?.items.map((model) => (
              <ModelRow key={model.id} model={model} provider={byId.get(model.providerId)} />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function ModelRow({ model, provider }: { model: Model; provider: Provider | undefined }) {
  return (
    <tr
      className="border-b border-border/60"
      data-testid={`model-row-${model.modelId}`}
      data-available={model.available}
    >
      <td
        className="py-2 pr-3"
        style={{ color: provider ? providerAccent(provider.type) : undefined }}
      >
        {provider?.name ?? (provider ? PROVIDER_TYPE_LABEL[provider.type] : 'unknown')}
      </td>
      <td className="py-2 pr-3">
        <span className="font-machine">{model.modelId}</span>
        {/* D286: what an alias means today, as the provider resolved it */}
        {model.resolvedModelId !== undefined && (
          <span className="ml-1 font-machine text-xs text-fg-muted" data-testid="model-resolves-to">
            → {model.resolvedModelId}
          </span>
        )}
        <span className="ml-2 text-fg-muted">{model.displayName}</span>
        {!model.available && (
          <span
            className="ml-2 rounded-chip border border-border px-1.5 py-0.5 text-xs text-fg-muted"
            title={model.unavailableReason}
          >
            unavailable
          </span>
        )}
        {(model.available ? model.description : model.unavailableReason) !== undefined && (
          <p className="mt-0.5 text-xs text-fg-muted" data-testid="model-note">
            {model.available ? model.description : model.unavailableReason}
          </p>
        )}
      </td>
      <td className="py-2 pr-3 font-machine text-xs text-fg-muted">
        {model.inputTypes.join('/')} → {model.outputTypes.join('/')}
      </td>
      <td className="py-2 pr-3 font-machine text-xs">{model.contextWindow.toLocaleString()}</td>
      <td className="py-2 pr-3 font-machine text-xs text-fg-muted">
        {model.supportsTools ? 'tools' : '—'} / {model.supportsJson ? 'json' : '—'}
      </td>
      <td className="py-2 pr-3 text-xs text-fg-muted">{model.source}</td>
      <td className="py-2 pr-3 font-machine text-xs">
        {model.pricing
          ? `${money(model.pricing.inputPer1k)} / ${money(model.pricing.outputPer1k)}`
          : '—'}
      </td>
    </tr>
  );
}

function FilterSelect({
  id,
  label,
  value,
  onChange,
  options,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} aria-label={label} className="w-40">
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
    </div>
  );
}

/** FR-MOD-006 refreshes one provider at a time, because that is what the endpoint takes. */
function RefreshMenu({
  providers,
  pending,
  onRefresh,
}: {
  providers: Provider[];
  pending: boolean;
  onRefresh: (providerId: string) => void;
}) {
  const [providerId, setProviderId] = useState(providers[0]?.id ?? '');
  const selected = providers.some((provider) => provider.id === providerId)
    ? providerId
    : (providers[0]?.id ?? '');

  return (
    <div className="flex items-end gap-2">
      {providers.length > 1 && (
        <Select value={selected} onValueChange={setProviderId}>
          <SelectTrigger aria-label="Provider to refresh" className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {providers.map((provider) => (
              <SelectItem key={provider.id} value={provider.id}>
                {provider.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <Button
        variant="secondary"
        disabled={pending || !selected}
        onClick={() => selected && onRefresh(selected)}
      >
        <RefreshCw className="h-4 w-4" /> Refresh models
      </Button>
    </div>
  );
}
