import type { CapabilityNeeds, DataType, Model, Provider, RoutingPolicy } from '@ace/contracts';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, cn } from '@ace/ui';
import { useId } from 'react';

import { useResolvedTheme } from '../app/theme';
import { ProviderSelectGroups } from '../providers/ProviderModelPicker';
import { modelCapabilityBlock } from '../providers/model-capability';
import { useModels, useProviders } from '../providers/hooks';
import { isLocalProvider, LOCAL_COST_TEXT } from '../runs/CostValue';
import { localModelFacts } from '../providers/provider-groups';
import { th, themeProviderOf } from '../theme/constants';
import { ProviderOrb } from '../theme/primitives';
import { FIELD_GRID_CLASS, Field, HELP_CLASS } from './fields';

/**
 * Why a model cannot be chosen for this node (FR-NODE-004, TC-NODE-003). It is listed, disabled,
 * with the reason — hiding it would leave the user wondering where their model went.
 */
export function modelBlockedReason(
  model: Model,
  inputTypes: readonly DataType[],
  outputTypes: readonly DataType[],
): string | undefined {
  if (!model.available) return model.unavailableReason ?? 'unavailable';
  const missingIn = inputTypes.filter((type) => !model.inputTypes.includes(type));
  const missingOut = outputTypes.filter((type) => !model.outputTypes.includes(type));
  if (missingIn.length > 0) return `no ${missingIn.join('/')} input`;
  if (missingOut.length > 0) return `no ${missingOut.join('/')} output`;
  return undefined;
}

export interface ProviderAndModelProps {
  providerId: string | undefined;
  modelId: string | undefined;
  inputTypes: readonly DataType[];
  outputTypes: readonly DataType[];
  /** What the node asks of its model beyond data types — a schema, tools, skills (D353). */
  needs?: CapabilityNeeds;
  onChange: (patch: { providerId?: string; modelId?: string }) => void;
}

/** A provider's 20px orb, as the theme's provider dropdown draws it beside each name. */
function SmallOrb({ type }: { type: Provider['type'] }) {
  const dark = useResolvedTheme() === 'dark';
  return <ProviderOrb look={th(themeProviderOf(type), dark)} size={20} logo={11} />;
}

/**
 * The modal's first row (FR-NODE-003/004/005, D333): Model provider → Model, side by side. The
 * providers are the registry's records, each with its orb; the models are the engine's catalog
 * narrowed to that provider. A model that cannot serve the node's data types, or that the provider
 * no longer offers, stays visible and disabled with its reason.
 */
export function ProviderAndModel({
  providerId,
  modelId,
  inputTypes,
  outputTypes,
  needs,
  onChange,
}: ProviderAndModelProps) {
  const providers = useProviders();
  const models = useModels(providerId === undefined ? {} : { providerId });
  const providerList = providers.data ?? [];
  const chosen = providerList.find((provider) => provider.id === providerId);
  const modelList = providerId === undefined ? [] : (models.data?.items ?? []);
  const picked = modelList.find((model) => model.modelId === modelId);
  // PG-1.4: a local model shows its size and tools/JSON, and is free by rule.
  const local = isLocalProvider(chosen);
  // D286: a model the node names that its provider no longer lists — never shown as if usable.
  const gone = modelId !== undefined && modelId !== '' && models.isSuccess && picked === undefined;
  // D353: the chosen model cannot honour this node's schema or tools — the pre-flight error, early.
  const pickedBlock =
    picked === undefined ? undefined : modelCapabilityBlock(picked, needs, chosen);
  const modelHint =
    providerId === undefined
      ? 'choose a provider first'
      : models.isSuccess && modelList.length === 0
        ? 'no models listed — Providers › Models › Refresh models'
        : undefined;

  return (
    <div className={FIELD_GRID_CLASS}>
      <Field
        label="Model provider"
        htmlFor="config-provider"
        {...(providerList.length === 0 && providers.isSuccess
          ? { hint: 'add a provider on the Providers screen' }
          : {})}
      >
        <Select
          value={providerId ?? ''}
          onValueChange={(value) => onChange({ providerId: value, modelId: '' })}
          disabled={providerList.length === 0}
        >
          <SelectTrigger id="config-provider" aria-label="Provider">
            <SelectValue placeholder="none">
              {chosen && (
                <span className="flex min-w-0 items-center gap-[9px]">
                  <SmallOrb type={chosen.type} />
                  <span className="truncate">{chosen.name}</span>
                </span>
              )}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {/* PG-1.4: the providers in their sections — Cloud APIs, Local & open models, … */}
            <ProviderSelectGroups
              providers={providerList}
              renderIcon={(provider) => <SmallOrb type={provider.type} />}
            />
          </SelectContent>
        </Select>
        {/* FR-PRV-005: the node keeps pointing at a provider the engine no longer has. */}
        {providerId !== undefined && chosen === undefined && providers.isSuccess && (
          <p role="alert" className={HELP_CLASS} data-testid="config-provider-missing">
            This node’s provider was removed. Choose another before running.
          </p>
        )}
      </Field>

      <Field
        label="Model"
        htmlFor="config-model"
        {...(modelHint === undefined ? {} : { hint: modelHint })}
      >
        <Select
          value={modelId ?? ''}
          onValueChange={(value) => onChange({ modelId: value })}
          disabled={providerId === undefined || modelList.length === 0}
        >
          <SelectTrigger id="config-model" aria-label="Model">
            <SelectValue placeholder="no model" />
          </SelectTrigger>
          <SelectContent>
            {modelList.map((model) => {
              const capability = modelCapabilityBlock(model, needs, chosen);
              const blocked =
                modelBlockedReason(model, inputTypes, outputTypes) ?? capability?.short;
              return (
                <SelectItem
                  key={model.id}
                  value={model.modelId}
                  disabled={blocked !== undefined}
                  data-blocked={blocked ?? undefined}
                  title={capability?.reason}
                >
                  {model.displayName}
                  {model.resolvedModelId !== undefined ? ` · ${model.resolvedModelId}` : ''}
                  {local ? ` · ${localModelFacts(model)}` : ''}
                  {blocked ? ` — ${blocked}` : ''}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
        {/* D286: what the chosen model really is — an alias resolved — in the provider's words */}
        {picked !== undefined &&
          (picked.resolvedModelId !== undefined || picked.description !== undefined) && (
            <p className={HELP_CLASS} data-testid="config-model-detail">
              <span className="font-machine">{picked.modelId}</span>
              {picked.resolvedModelId !== undefined && (
                <span className="font-machine"> → {picked.resolvedModelId}</span>
              )}
              {picked.description !== undefined && <span> · {picked.description}</span>}
            </p>
          )}
        {local && picked !== undefined && (
          <p className={HELP_CLASS} data-testid="config-model-local">
            {LOCAL_COST_TEXT}
          </p>
        )}
        {pickedBlock !== undefined && (
          <p role="alert" className={HELP_CLASS} data-testid="config-model-capability">
            {pickedBlock.reason}
          </p>
        )}
        {gone && (
          <p role="alert" className={HELP_CLASS} data-testid="config-model-gone">
            “{modelId}” is not in this provider’s model list any more. Choose another, or refresh
            the provider’s models.
          </p>
        )}
      </Field>
    </div>
  );
}

/** The theme's small square glyph button (28px, radius 7), for the fallback list's row actions. */
const ROW_BUTTON_CLASS =
  'grid h-7 w-7 shrink-0 cursor-pointer place-items-center rounded-[7px] border-none bg-transparent text-[12px] text-[var(--muted)] outline-none hover:bg-[var(--hover)] hover:text-[var(--ink)] focus-visible:shadow-[0_0_0_2px_#ef6b3f] disabled:cursor-not-allowed disabled:opacity-45';

/**
 * The ordered fallback list (FR-RTR-002). Only meaningful under the `fallback` policy, and the
 * order is the order the router walks, so moving an entry is a first-class action rather than a
 * re-type.
 */
export function FallbackModels({
  policy,
  providerId,
  fallbackModelIds,
  onChange,
}: {
  policy: RoutingPolicy;
  providerId: string | undefined;
  fallbackModelIds: readonly string[];
  onChange: (ids: string[]) => void;
}) {
  const id = useId();
  const models = useModels(providerId === undefined ? {} : { providerId });
  const options = (models.data?.items ?? []).filter(
    (model) => model.available && !fallbackModelIds.includes(model.modelId),
  );

  if (policy !== 'fallback') return null;

  const move = (index: number, delta: number) => {
    const next = [...fallbackModelIds];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved as string);
    onChange(next);
  };

  return (
    <Field label="Fallback models, in order" htmlFor={id}>
      <div className="flex flex-col gap-2" data-testid="fallback-models">
        {fallbackModelIds.length > 0 && (
          <ol className="flex flex-col gap-1">
            {fallbackModelIds.map((fallbackId, index) => (
              <li
                key={fallbackId}
                className="flex h-[38px] items-center gap-2 rounded-[9px] border border-[var(--line)] pl-3 pr-1"
              >
                <span className="w-4 font-machine text-[11px] text-[var(--muted)]">
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1 truncate font-machine text-[12px] text-[var(--ink)]">
                  {fallbackId}
                </span>
                <button
                  type="button"
                  className={ROW_BUTTON_CLASS}
                  aria-label={`Move ${fallbackId} up`}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  <span aria-hidden>↑</span>
                </button>
                <button
                  type="button"
                  className={ROW_BUTTON_CLASS}
                  aria-label={`Move ${fallbackId} down`}
                  disabled={index === fallbackModelIds.length - 1}
                  onClick={() => move(index, 1)}
                >
                  <span aria-hidden>↓</span>
                </button>
                <button
                  type="button"
                  className={cn(ROW_BUTTON_CLASS, 'hover:text-[#c94c27]')}
                  aria-label={`Remove ${fallbackId}`}
                  onClick={() => onChange(fallbackModelIds.filter((value) => value !== fallbackId))}
                >
                  <span aria-hidden>✕</span>
                </button>
              </li>
            ))}
          </ol>
        )}
        <Select
          value=""
          onValueChange={(value) => onChange([...fallbackModelIds, value])}
          disabled={options.length === 0}
        >
          <SelectTrigger id={id} aria-label="Add a fallback model">
            <SelectValue
              placeholder={options.length === 0 ? 'nothing left to add' : 'add a model'}
            />
          </SelectTrigger>
          <SelectContent>
            {options.map((model) => (
              <SelectItem key={model.id} value={model.modelId}>
                {model.displayName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {fallbackModelIds.length === 0 && (
          <p className={HELP_CLASS}>None yet — the router will only use the model above.</p>
        )}
      </div>
    </Field>
  );
}

/** Whether this provider is one the engine still has — used by the Canvas badge too. */
export function providerFor(
  providers: readonly Provider[],
  providerId: string | undefined,
): Provider | undefined {
  return providerId === undefined
    ? undefined
    : providers.find((provider) => provider.id === providerId);
}
