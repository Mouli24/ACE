import { providerGroup, type Model, type Provider } from '@ace/contracts';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Icons,
  SelectGroup,
  SelectItem,
  cn,
} from '@ace/ui';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useInRouterContext } from 'react-router-dom';

import { LOCAL_COST_TEXT } from '../runs/CostValue';
import { ProviderMark } from './ProviderMark';
import { useCreateProvider, useModels, useProviderDetect, useProviders } from './hooks';
import { groupProviders, localModelFacts, pullCommand } from './provider-groups';
import { PROVIDER_STATE_LABEL } from './provider-meta';
import { useProviderPicker, type ProviderChoice } from './provider-picker-store';

/**
 * PG-1.3 / PG-1.4 (D351, D359): the one grouped provider-and-model picker. Every place that picks a
 * provider shows the same sections — Cloud APIs, Local & open models, CLI agents, Custom endpoints,
 * Test providers — from the contract's `providerGroup`.
 */

const GROUP_HEADING =
  'px-[10px] pb-[3px] pt-[7px] font-machine text-[9.5px] uppercase tracking-[0.1em] text-[var(--muted)]';

/* ----------------------------------------------------------------- node settings' Select */

/**
 * The provider Select's items in their sections (node settings, PG-1.4). Each section is a
 * `group` named by its label, so a screen reader announces "Local & open models" before Ollama.
 */
export function ProviderSelectGroups({
  providers,
  renderIcon,
}: {
  providers: readonly Provider[];
  renderIcon?: (provider: Provider) => ReactNode;
}) {
  return (
    <>
      {groupProviders(providers).map((section) => (
        <SelectGroup
          key={section.group}
          aria-label={section.label}
          aria-labelledby={undefined}
          data-testid={`provider-group-${section.group}`}
        >
          <div aria-hidden className={GROUP_HEADING}>
            {section.label}
          </div>
          {section.providers.map((provider) => (
            <SelectItem
              key={provider.id}
              value={provider.id}
              {...(renderIcon === undefined ? {} : { icon: renderIcon(provider) })}
            >
              {provider.name}
            </SelectItem>
          ))}
        </SelectGroup>
      ))}
    </>
  );
}

/* ------------------------------------------------------------- the Local & open pieces */

/** "Pull a model" with the exact command, for a local runtime that has no model yet (PG-1.4). */
export function PullModelHint({ className }: { className?: string }) {
  return (
    <p className={cn('text-[12px] text-[var(--muted)]', className)} data-testid="pull-model-hint">
      Pull a model: run{' '}
      <code className="rounded-[5px] bg-[var(--soft)] px-[6px] py-[1px] font-machine text-[11.5px] text-[var(--ink)]">
        {pullCommand()}
      </code>{' '}
      in a terminal, then refresh this provider’s models.
    </p>
  );
}

/** The models a local runtime has on this machine: size, tools/JSON, and no price (PG-1.4). */
export function LocalModelsList({ provider }: { provider: Provider }) {
  const models = useModels({ providerId: provider.id });
  const items = models.data?.items ?? [];
  if (models.isPending) {
    return <p className="text-[12px] text-[var(--muted)]">Looking for models…</p>;
  }
  if (items.length === 0) return <PullModelHint />;
  return (
    <ul className="flex flex-col gap-[4px]" data-testid={`local-models-${provider.id}`}>
      {items.map((model) => (
        <li
          key={model.id}
          className="flex flex-wrap items-baseline gap-x-3 gap-y-[2px] text-[12px]"
          data-testid={`local-model-${model.modelId}`}
        >
          <span className="font-machine text-[12px] text-[var(--ink)]">{model.modelId}</span>
          <span className="font-machine text-[10.5px] text-[var(--muted)]">
            {localModelFacts(model)}
          </span>
          <span className="text-[11px] text-[#2f7d52]">{LOCAL_COST_TEXT}</span>
        </li>
      ))}
    </ul>
  );
}

/* ----------------------------------------------------------------- the two-step picker */

const OPTION =
  'flex w-full cursor-pointer items-center gap-[9px] rounded-[8px] border border-transparent bg-transparent px-[9px] py-[6px] text-left text-[12.5px] text-[var(--ink)] outline-none hover:bg-[var(--hover)] focus-visible:border-[#ef6b3f] aria-selected:border-[var(--ink)] aria-selected:font-semibold disabled:cursor-not-allowed disabled:opacity-50';

function ProviderOption({
  provider,
  selected,
  onSelect,
}: {
  provider: Provider;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      data-testid={`picker-provider-${provider.id}`}
      className={OPTION}
      onClick={onSelect}
    >
      <ProviderMark type={provider.type} />
      <span className="min-w-0 flex-1 truncate">{provider.name}</span>
      <span className="shrink-0 font-machine text-[10px] text-[var(--muted)]">
        {PROVIDER_STATE_LABEL[provider.status]}
      </span>
    </button>
  );
}

function ModelOption({
  model,
  local,
  selected,
  onSelect,
}: {
  model: Model;
  local: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      aria-disabled={!model.available}
      disabled={!model.available}
      title={model.available ? undefined : model.unavailableReason}
      data-testid={`picker-model-${model.modelId}`}
      className={OPTION}
      onClick={onSelect}
    >
      <span className="min-w-0 flex-1 truncate">{model.displayName}</span>
      <span className="shrink-0 font-machine text-[10px] text-[var(--muted)]">
        {local ? `${localModelFacts(model)} · ${LOCAL_COST_TEXT}` : model.modelId}
      </span>
    </button>
  );
}

/**
 * Provider, then model (PG-1.3): the providers in their PG-1.4 sections, then the chosen
 * provider's models. Local models show their size, tools/JSON and "Free · runs on your machine";
 * a local runtime with none shows the `ollama pull` command.
 */
export function ProviderModelPicker({
  providers,
  value,
  onChange,
}: {
  providers: readonly Provider[];
  value: Partial<ProviderChoice>;
  onChange: (value: Partial<ProviderChoice>) => void;
}) {
  const chosen = providers.find((provider) => provider.id === value.providerId);
  const models = useModels(chosen === undefined ? {} : { providerId: chosen.id });
  const modelList = chosen === undefined ? [] : (models.data?.items ?? []);
  const local = chosen !== undefined && providerGroup(chosen) === 'local';

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="flex min-w-0 flex-col gap-[6px]">
        <span id="picker-provider-label" className="text-[12px] font-semibold">
          1. Provider
        </span>
        <div
          role="listbox"
          aria-labelledby="picker-provider-label"
          className="flex max-h-[300px] flex-col gap-[2px] overflow-y-auto"
        >
          {groupProviders(providers).map((section) => (
            <div
              key={section.group}
              role="group"
              aria-label={section.label}
              data-testid={`picker-group-${section.group}`}
            >
              <div aria-hidden className={GROUP_HEADING}>
                {section.label}
              </div>
              {section.providers.map((provider) => (
                <ProviderOption
                  key={provider.id}
                  provider={provider}
                  selected={provider.id === value.providerId}
                  onSelect={() => onChange({ providerId: provider.id })}
                />
              ))}
            </div>
          ))}
        </div>
      </div>

      <div className="flex min-w-0 flex-col gap-[6px]">
        <span id="picker-model-label" className="text-[12px] font-semibold">
          2. Model
        </span>
        {chosen === undefined ? (
          <p className="text-[12px] text-[var(--muted)]">Choose a provider first.</p>
        ) : models.isPending ? (
          <p className="text-[12px] text-[var(--muted)]">Loading models…</p>
        ) : modelList.length === 0 ? (
          local ? (
            <PullModelHint />
          ) : (
            <p className="text-[12px] text-[var(--muted)]">
              This provider lists no models yet — refresh them on the Providers screen.
            </p>
          )
        ) : (
          <div
            role="listbox"
            aria-labelledby="picker-model-label"
            className="flex max-h-[300px] flex-col gap-[2px] overflow-y-auto"
          >
            {modelList.map((model) => (
              <ModelOption
                key={model.id}
                model={model}
                local={local}
                selected={model.modelId === value.modelId}
                onSelect={() => onChange({ providerId: chosen.id, modelId: model.modelId })}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------- no connected provider (FR-PRV-007) */

function ToProviders({ children }: { children: ReactNode }) {
  const inRouter = useInRouterContext();
  const className =
    'inline-flex items-center gap-[6px] rounded-[4px] text-[12.5px] font-semibold text-[var(--ink)] underline outline-none focus-visible:shadow-[0_0_0_2px_#ef6b3f]';
  return inRouter ? (
    <Link to="/providers" className={className} data-testid="picker-connect-provider">
      {children}
    </Link>
  ) : (
    <a href="/providers" className={className} data-testid="picker-connect-provider">
      {children}
    </a>
  );
}

/**
 * Shown when no provider is CONNECTED: the way to the Providers page, and a local Ollama the
 * engine found on its default address, added in one click (FR-PRV-007).
 */
function ConnectAProvider({
  providers,
  onAdded,
}: {
  providers: readonly Provider[];
  onAdded: (provider: Provider) => void;
}) {
  const detect = useProviderDetect();
  const create = useCreateProvider();
  const ollama = detect.data?.ollama;
  const ollamaAdded = providers.some((provider) => provider.type === 'ollama');
  return (
    <div
      className="flex flex-col gap-2 rounded-[12px] border border-[var(--line)] bg-[var(--soft)] p-3"
      data-testid="picker-no-connected-provider"
    >
      <p className="text-[12.5px]">No provider is connected yet.</p>
      <ToProviders>
        <Icons.PlugZap aria-hidden size={14} />
        Connect a provider
      </ToProviders>
      {ollama?.detected && !ollamaAdded && (
        <div className="flex flex-wrap items-center gap-2" data-testid="picker-ollama-detected">
          <ProviderMark type="ollama" />
          <span className="min-w-0 flex-1 text-[12px]">
            Ollama is running at <span className="font-machine">{ollama.baseUrl}</span>.
          </span>
          <Button
            size="sm"
            variant="secondary"
            disabled={create.isPending}
            onClick={() =>
              create.mutate(
                { type: 'ollama', name: 'Ollama', baseUrl: ollama.baseUrl },
                { onSuccess: onAdded },
              )
            }
          >
            Add Ollama
          </Button>
        </div>
      )}
      {create.isError && (
        <p role="alert" className="text-[12px] text-[#c94c27]">
          {create.error.message}
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------------- the dialog */

/**
 * PG-1.3 (D351): the provider-first dialog. Its confirm stays disabled until a provider *and* a
 * model are chosen; Cancel (or Escape, or the close button) creates nothing.
 */
export function ProviderPickerDialog({
  title = 'Choose a provider and model',
  confirmLabel = 'Add node',
  initial,
  onConfirm,
  onCancel,
}: {
  title?: string;
  confirmLabel?: string;
  initial?: Partial<ProviderChoice>;
  onConfirm: (choice: ProviderChoice) => void;
  onCancel: () => void;
}) {
  const providers = useProviders();
  const list = providers.data ?? [];
  const [value, setValue] = useState<Partial<ProviderChoice>>(initial ?? {});
  const connected = list.some((provider) => provider.status === 'CONNECTED');

  // A pre-selected provider that no longer exists is dropped (a duplicate of an imported node).
  // Only the initial one: a provider added from this dialog is chosen before the list refetches.
  const initialProviderId = initial?.providerId;
  useEffect(() => {
    if (
      providers.isSuccess &&
      initialProviderId !== undefined &&
      value.providerId === initialProviderId &&
      !list.some((provider) => provider.id === initialProviderId)
    ) {
      setValue({});
    }
  }, [providers.isSuccess, list, value.providerId, initialProviderId]);

  const ready =
    value.providerId !== undefined && value.modelId !== undefined && value.modelId !== '';

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-w-[680px]" data-testid="provider-picker">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Every agent needs a provider and a model before it can run. Nothing is created until you
            choose both.
          </DialogDescription>
        </DialogHeader>

        {providers.isSuccess && !connected && (
          <ConnectAProvider
            providers={list}
            onAdded={(provider) => setValue({ providerId: provider.id })}
          />
        )}

        {providers.isPending ? (
          <p className="text-[12px] text-[var(--muted)]">Loading providers…</p>
        ) : (
          <ProviderModelPicker providers={list} value={value} onChange={setValue} />
        )}

        <DialogFooter>
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            disabled={!ready}
            onClick={() =>
              ready && onConfirm({ providerId: value.providerId!, modelId: value.modelId! })
            }
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Mounted once by the Canvas: shows whatever the provider-first store was asked for. */
export function ProviderPickerHost() {
  const request = useProviderPicker((state) => state.request);
  const close = useProviderPicker((state) => state.close);
  // A request never outlives the Canvas that would act on it.
  useEffect(() => () => close(), [close]);
  if (request === undefined) return null;
  return (
    <ProviderPickerDialog
      {...(request.title === undefined ? {} : { title: request.title })}
      {...(request.confirmLabel === undefined ? {} : { confirmLabel: request.confirmLabel })}
      {...(request.initial === undefined ? {} : { initial: request.initial })}
      onConfirm={(choice) => {
        close();
        request.onChosen(choice);
      }}
      onCancel={() => {
        close();
        request.onCancel?.();
      }}
    />
  );
}
