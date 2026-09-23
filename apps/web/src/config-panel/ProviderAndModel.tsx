import type { DataType, Model, Provider, RoutingPolicy } from '@ace/contracts';
import {
  Button,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@ace/ui';
import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react';
import { useId } from 'react';

import { useModels, useProviders } from '../providers/hooks';
import { PROVIDER_TYPE_LABEL } from '../providers/provider-meta';
import { Field } from './fields';

/**
 * Why a model cannot be chosen for this node (FR-NODE-004, TC-NODE-003). It is listed, disabled,
 * with the reason — hiding it would leave the user wondering where their model went.
 */
export function modelBlockedReason(
  model: Model,
  inputTypes: readonly DataType[],
  outputTypes: readonly DataType[],
): string | undefined {
  if (!model.available) return 'unavailable';
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
  onChange: (patch: { providerId?: string; modelId?: string }) => void;
}

/**
 * Provider picker → model picker (FR-NODE-003/004/005). The model list is the engine's catalog
 * narrowed to this provider; a model that cannot serve the node's data types, or that the provider
 * no longer offers, stays visible and disabled with its reason.
 */
export function ProviderAndModel({
  providerId,
  modelId,
  inputTypes,
  outputTypes,
  onChange,
}: ProviderAndModelProps) {
  const providers = useProviders();
  const models = useModels(providerId === undefined ? {} : { providerId });
  const providerList = providers.data ?? [];
  const chosen = providerList.find((provider) => provider.id === providerId);
  const modelList = providerId === undefined ? [] : (models.data?.items ?? []);

  return (
    <>
      <Field
        label="Provider"
        htmlFor="config-provider"
        hint={providerList.length === 0 ? 'add a provider on the Providers screen' : undefined}
      >
        <Select
          value={providerId ?? ''}
          onValueChange={(value) => onChange({ providerId: value, modelId: '' })}
          disabled={providerList.length === 0}
        >
          <SelectTrigger id="config-provider" aria-label="Provider">
            <SelectValue placeholder="none" />
          </SelectTrigger>
          <SelectContent>
            {providerList.map((provider) => (
              <SelectItem key={provider.id} value={provider.id}>
                {provider.name} · {PROVIDER_TYPE_LABEL[provider.type]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      {/* FR-PRV-005: the node keeps pointing at a provider the engine no longer has. */}
      {providerId !== undefined && chosen === undefined && providers.isSuccess && (
        <p role="alert" className="px-0 text-xs text-danger" data-testid="config-provider-missing">
          This node’s provider was removed. Choose another before running.
        </p>
      )}

      <Field
        label="Model"
        htmlFor="config-model"
        hint={providerId === undefined ? 'choose a provider first' : undefined}
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
              const blocked = modelBlockedReason(model, inputTypes, outputTypes);
              return (
                <SelectItem
                  key={model.id}
                  value={model.modelId}
                  disabled={blocked !== undefined}
                  data-blocked={blocked ?? undefined}
                >
                  {model.displayName}
                  {blocked ? ` — ${blocked}` : ''}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      </Field>
    </>
  );
}

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
    <div className="flex flex-col gap-1.5" data-testid="fallback-models">
      <Label htmlFor={id}>Fallback models, in order</Label>
      <ol className="flex flex-col gap-1">
        {fallbackModelIds.map((fallbackId, index) => (
          <li key={fallbackId} className="flex items-center gap-1">
            <span className="w-4 font-machine text-xs text-fg-muted">{index + 1}</span>
            <span className="flex-1 truncate font-machine text-xs">{fallbackId}</span>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Move ${fallbackId} up`}
              disabled={index === 0}
              onClick={() => move(index, -1)}
            >
              <ArrowUp className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Move ${fallbackId} down`}
              disabled={index === fallbackModelIds.length - 1}
              onClick={() => move(index, 1)}
            >
              <ArrowDown className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Remove ${fallbackId}`}
              onClick={() => onChange(fallbackModelIds.filter((value) => value !== fallbackId))}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </li>
        ))}
      </ol>
      {fallbackModelIds.length === 0 && (
        <p className="text-xs text-fg-muted">
          None yet — the router will only use the model above.
        </p>
      )}
      <div className="flex items-center gap-2">
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
        <Plus className="h-4 w-4 shrink-0 text-fg-muted" aria-hidden />
      </div>
    </div>
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
