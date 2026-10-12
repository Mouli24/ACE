import {
  DATA_TYPES,
  type DataType,
  type Model,
  type ModelQuery,
  type Provider,
} from '@ace/contracts';
import {
  Badge,
  Button,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@ace/ui';
import { useState } from 'react';

import { ProviderMark } from './ProviderMark';
import { useModels, useRefreshModels } from './hooks';
import { PROVIDER_TYPE_LABEL } from './provider-meta';

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

/** A theme table cell: 12.5px rows about 36px tall. */
const CELL = 'px-3 py-[9px] align-top';

/**
 * The model catalog (FR-MOD-004/006, TC-MOD-003). Filtering is done by the engine — the same
 * `ModelQuery` the config panel narrows with — so the table and the model picker can never disagree
 * about what "supports image input" means (D29). Theme dropdowns over a theme table (D328).
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
      <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-x-4 gap-y-5">
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
      </div>

      <div className="flex flex-wrap items-center justify-end gap-3">
        <p
          className="mr-auto font-machine text-[10px] text-[var(--muted)]"
          data-testid="models-refreshed-at"
        >
          refreshed{' '}
          {new Date(refreshedAt ?? models.data?.refreshedAt ?? Date.now()).toLocaleTimeString()}
        </p>
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
      </div>

      {warning !== undefined && (
        <p
          role="alert"
          data-testid="models-refresh-warning"
          className="rounded-[10px] border border-[rgba(201,76,39,0.35)] bg-[rgba(201,76,39,0.08)] px-3 py-2 text-[12px] text-[var(--ink)]"
        >
          The provider could not list its models: {warning}
        </p>
      )}

      {models.isError && (
        <p role="alert" className="text-[12px] text-[#c94c27]">
          Could not load models: {models.error.message}
        </p>
      )}
      {models.data?.items.length === 0 && (
        <p className="py-10 text-center text-[13px] text-[var(--muted)]">
          No model matches these filters.
        </p>
      )}

      {(models.data?.items.length ?? 0) > 0 && (
        <div className="overflow-x-auto rounded-[12px] border border-[var(--line)] bg-[var(--surface)]">
          <table className="w-full border-collapse text-[12.5px]" data-testid="models-table">
            <thead>
              <tr className="h-9 text-left font-machine text-[9.5px] uppercase tracking-[0.1em] text-[var(--muted)]">
                <th className="px-3 font-medium">Provider</th>
                <th className="px-3 font-medium">Model</th>
                <th className="px-3 font-medium">In → out</th>
                <th className="px-3 font-medium">Context</th>
                <th className="px-3 font-medium">Tools / JSON</th>
                <th className="px-3 font-medium">Source</th>
                <th className="px-3 font-medium">Price / 1k</th>
              </tr>
            </thead>
            <tbody>
              {models.data?.items.map((model) => (
                <ModelRow key={model.id} model={model} provider={byId.get(model.providerId)} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function ModelRow({ model, provider }: { model: Model; provider: Provider | undefined }) {
  const note = model.available ? model.description : model.unavailableReason;
  return (
    <tr
      className="border-t border-[var(--line)]"
      data-testid={`model-row-${model.modelId}`}
      data-available={model.available}
    >
      <td className={CELL}>
        <span className="flex items-center gap-2 whitespace-nowrap">
          {provider && <ProviderMark type={provider.type} />}
          {provider?.name ?? (provider ? PROVIDER_TYPE_LABEL[provider.type] : 'unknown')}
        </span>
      </td>
      <td className={CELL}>
        <span className="font-machine text-[12px]">{model.modelId}</span>
        {/* D286: what an alias means today, as the provider resolved it */}
        {model.resolvedModelId !== undefined && (
          <span
            className="ml-1 font-machine text-[11px] text-[var(--muted)]"
            data-testid="model-resolves-to"
          >
            → {model.resolvedModelId}
          </span>
        )}
        <span className="ml-2 text-[var(--muted)]">{model.displayName}</span>
        {!model.available && (
          <Badge variant="outline" className="ml-2" title={model.unavailableReason}>
            unavailable
          </Badge>
        )}
        {note !== undefined && (
          <p
            className="mt-0.5 text-[11px] leading-[1.45] text-[var(--muted)]"
            data-testid="model-note"
          >
            {note}
          </p>
        )}
      </td>
      <td className={`${CELL} whitespace-nowrap font-machine text-[11px] text-[var(--muted)]`}>
        {model.inputTypes.join('/')} → {model.outputTypes.join('/')}
      </td>
      <td className={`${CELL} font-machine text-[11px]`}>{model.contextWindow.toLocaleString()}</td>
      <td className={`${CELL} whitespace-nowrap font-machine text-[11px] text-[var(--muted)]`}>
        {model.supportsTools ? 'tools' : '—'} / {model.supportsJson ? 'json' : '—'}
      </td>
      <td className={`${CELL} text-[11px] text-[var(--muted)]`}>{model.source}</td>
      <td className={`${CELL} whitespace-nowrap font-machine text-[11px]`}>
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
    <div className="flex min-w-0 flex-col gap-[7px]">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} aria-label={label}>
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
    <div className="flex flex-wrap items-center gap-2">
      {providers.length > 1 && (
        <Select value={selected} onValueChange={setProviderId}>
          <SelectTrigger aria-label="Provider to refresh" className="w-48">
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
        <span aria-hidden>↺</span> Refresh models
      </Button>
    </div>
  );
}
