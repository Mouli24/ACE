import {
  CLI_PERMISSIONS,
  DEFAULT_CLI_CONCURRENCY,
  DEFAULT_CLI_PERMISSION,
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_PROVIDER_CONCURRENCY,
  PROVIDER_CONCURRENCY_MAX,
  PROVIDER_CONCURRENCY_MIN,
  PROVIDER_TYPES,
  isCliProviderType,
  type CliPermission,
  type CliProviderType,
  type Provider,
  type ProviderType,
} from '@ace/contracts';
import { AceApiError } from '@ace/sdk';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@ace/ui';
import { useState, type FormEvent } from 'react';

import { CliScanSection } from './CliScanSection';
import { useCreateProvider, useDeleteProvider, useUpdateProvider } from './hooks';
import {
  cliPermissionHint,
  CLI_PERMISSION_LABEL,
  NEEDS_API_KEY,
  NEEDS_BASE_URL,
  PROVIDER_TYPE_LABEL,
} from './provider-meta';

const concurrencyHint = `${PROVIDER_CONCURRENCY_MIN}–${PROVIDER_CONCURRENCY_MAX} calls in flight (FR-PRV-009)`;

/** What the engine put in the 409 body when a provider is still referenced (FR-PRV-005). */
function affectedNodeIds(error: unknown): string[] | undefined {
  if (!AceApiError.is(error) || error.code !== 'provider_in_use') return undefined;
  const details = error.details as { nodeIds?: unknown } | undefined;
  return Array.isArray(details?.nodeIds) ? details.nodeIds.map(String) : [];
}

function ErrorLine({ error }: { error: Error | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="text-sm text-danger">
      {error.message}
    </p>
  );
}

/** D262's preset, with what it lets the CLI do spelled out under it. */
function PermissionField({
  id,
  cliType,
  value,
  onChange,
}: {
  id: string;
  cliType: CliProviderType;
  value: CliPermission;
  onChange: (next: CliPermission) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>Permission</Label>
      <Select value={value} onValueChange={(next) => onChange(next as CliPermission)}>
        <SelectTrigger id={id} aria-label="Permission">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {CLI_PERMISSIONS.map((level) => (
            <SelectItem key={level} value={level}>
              {CLI_PERMISSION_LABEL[level]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p
        data-testid="cli-permission-hint"
        className={value === 'full_auto' ? 'text-xs text-danger' : 'text-xs text-fg-muted'}
      >
        {cliPermissionHint(cliType, value)}
      </p>
    </div>
  );
}

/**
 * Add a provider (FR-PRV-001). Which fields appear follows the type: the cloud types need a key,
 * the two local ones need a base URL (Ollama's is prefilled), and `mock` needs nothing at all.
 * The key field is write-only — it is never prefilled and never read back (FR-PRV-002, BR-07).
 */
export function AddProviderDialog({
  onClose,
  detectedOllamaBaseUrl,
}: {
  onClose: () => void;
  detectedOllamaBaseUrl?: string;
}) {
  const create = useCreateProvider();
  const [type, setType] = useState<ProviderType>('anthropic');
  const [name, setName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [concurrency, setConcurrency] = useState(String(DEFAULT_PROVIDER_CONCURRENCY));
  const [permission, setPermission] = useState<CliPermission>(DEFAULT_CLI_PERMISSION);
  const isCli = isCliProviderType(type);

  const needsKey = NEEDS_API_KEY.has(type);
  const needsBaseUrl = NEEDS_BASE_URL.has(type);
  const effectiveBaseUrl =
    baseUrl.trim() || (type === 'ollama' ? (detectedOllamaBaseUrl ?? DEFAULT_OLLAMA_BASE_URL) : '');

  const pickType = (next: ProviderType) => {
    setType(next);
    // The address is per type, so switching away from a local provider must not carry it over.
    setBaseUrl(next === 'ollama' ? (detectedOllamaBaseUrl ?? DEFAULT_OLLAMA_BASE_URL) : '');
    if (!name.trim()) setName(PROVIDER_TYPE_LABEL[next]);
    if (isCliProviderType(next)) {
      // A CLI brings its own sign-in, and two agents in one folder collide (D262).
      setApiKey('');
      setPermission(DEFAULT_CLI_PERMISSION);
      setConcurrency(String(DEFAULT_CLI_CONCURRENCY));
    }
  };

  /** "Add" on a scanned CLI: the form, filled in for it. */
  const addFromScan = (next: CliProviderType) => {
    setName(PROVIDER_TYPE_LABEL[next]);
    pickType(next);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate(
      {
        type,
        name: name.trim() || PROVIDER_TYPE_LABEL[type],
        ...(!isCli && apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        ...(effectiveBaseUrl ? { baseUrl: effectiveBaseUrl } : {}),
        concurrency: Number(concurrency) || DEFAULT_PROVIDER_CONCURRENCY,
        ...(isCli ? { cliPermission: permission } : {}),
      },
      { onSuccess: onClose },
    );
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Add provider</DialogTitle>
            <DialogDescription>
              Keys are stored in the OS keychain and never shown again. A coding-agent CLI found in
              your terminal uses its own sign-in.
            </DialogDescription>
          </DialogHeader>

          <CliScanSection onAdd={addFromScan} />

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="provider-type">Type</Label>
            <Select value={type} onValueChange={(value) => pickType(value as ProviderType)}>
              <SelectTrigger id="provider-type" aria-label="Type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROVIDER_TYPES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {PROVIDER_TYPE_LABEL[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="provider-name">Name</Label>
            <Input
              id="provider-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={80}
              placeholder={PROVIDER_TYPE_LABEL[type]}
              autoFocus
            />
          </div>

          {isCliProviderType(type) && (
            <PermissionField
              id="provider-cli-permission"
              cliType={type}
              value={permission}
              onChange={setPermission}
            />
          )}

          {needsKey && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="provider-key">API key</Label>
              <Input
                id="provider-key"
                type="password"
                className="font-machine"
                autoComplete="off"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                required
              />
            </div>
          )}

          {needsBaseUrl && (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="provider-base-url">Base URL</Label>
                <Input
                  id="provider-base-url"
                  className="font-machine"
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                  required
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="provider-optional-key">API key (optional)</Label>
                <Input
                  id="provider-optional-key"
                  type="password"
                  className="font-machine"
                  autoComplete="off"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                />
              </div>
            </>
          )}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="provider-concurrency">Concurrency</Label>
            <Input
              id="provider-concurrency"
              type="number"
              min={PROVIDER_CONCURRENCY_MIN}
              max={PROVIDER_CONCURRENCY_MAX}
              className="font-machine"
              value={concurrency}
              onChange={(event) => setConcurrency(event.target.value)}
            />
            <p className="text-xs text-fg-muted">{concurrencyHint}</p>
          </div>

          <ErrorLine error={create.error} />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending}>
              Add provider
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Edit a provider (FR-PRV-001). An empty key field leaves the stored key alone; typing one rotates
 * it (§2.1). The current key is never fetched, so there is nothing to prefill (FR-PRV-002).
 */
export function EditProviderDialog({
  provider,
  onClose,
}: {
  provider: Provider;
  onClose: () => void;
}) {
  const update = useUpdateProvider();
  const [name, setName] = useState(provider.name);
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  const [concurrency, setConcurrency] = useState(String(provider.concurrency));
  const isCli = isCliProviderType(provider.type);
  const [permission, setPermission] = useState<CliPermission>(
    provider.cliPermission ?? DEFAULT_CLI_PERMISSION,
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    update.mutate(
      {
        id: provider.id,
        name: name.trim(),
        ...(!isCli && apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        ...(isCli ? { cliPermission: permission } : {}),
        // `baseUrl` is optional in the patch, so an emptied field cannot clear it — the contract has
        // no way to say "remove this". The field is required for the two types that need one, and
        // for the others there is nothing to clear, so an empty box means "leave it alone".
        ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
        concurrency: Number(concurrency) || provider.concurrency,
      },
      { onSuccess: onClose },
    );
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Edit {provider.name}</DialogTitle>
            <DialogDescription>
              {isCli
                ? 'Uses the CLI’s own sign-in; ACE stores no key for it.'
                : provider.keySet
                  ? 'A key is stored. Leave the field empty to keep it, or type a new one to rotate it.'
                  : 'No key is stored for this provider.'}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-provider-name">Name</Label>
            <Input
              id="edit-provider-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={80}
              required
              autoFocus
            />
          </div>

          {isCliProviderType(provider.type) && (
            <PermissionField
              id="edit-provider-cli-permission"
              cliType={provider.type}
              value={permission}
              onChange={setPermission}
            />
          )}

          {NEEDS_BASE_URL.has(provider.type) && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="edit-provider-base-url">Base URL</Label>
              <Input
                id="edit-provider-base-url"
                className="font-machine"
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                required
              />
            </div>
          )}

          {!isCli && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="edit-provider-key">
                {provider.keySet ? 'Rotate API key' : 'API key'}
              </Label>
              <Input
                id="edit-provider-key"
                type="password"
                className="font-machine"
                autoComplete="off"
                placeholder={provider.keySet ? 'unchanged' : 'none stored'}
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
              />
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-provider-concurrency">Concurrency</Label>
            <Input
              id="edit-provider-concurrency"
              type="number"
              min={PROVIDER_CONCURRENCY_MIN}
              max={PROVIDER_CONCURRENCY_MAX}
              className="font-machine"
              value={concurrency}
              onChange={(event) => setConcurrency(event.target.value)}
            />
            <p className="text-xs text-fg-muted">{concurrencyHint}</p>
          </div>

          <ErrorLine error={update.error} />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || update.isPending}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Remove a provider (FR-PRV-005). The first attempt goes without `confirm`; if the engine answers
 * 409 the dialog names the nodes that still use it and only then repeats the call with
 * `?confirm=true`, after which those nodes carry a "provider missing" badge.
 */
export function DeleteProviderDialog({
  provider,
  onClose,
}: {
  provider: Provider;
  onClose: () => void;
}) {
  const remove = useDeleteProvider();
  const inUse = affectedNodeIds(remove.error);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove “{provider.name}”?</DialogTitle>
          <DialogDescription>
            Its stored key is deleted from the keychain. Models from this provider leave the
            catalog.
          </DialogDescription>
        </DialogHeader>

        {inUse !== undefined && (
          <div
            role="alert"
            data-testid="provider-in-use"
            className="flex flex-col gap-2 rounded-card border border-border bg-card p-3 text-sm"
          >
            <p>{remove.error?.message}</p>
            {inUse.length > 0 && (
              <ul className="flex flex-col gap-1 font-machine text-xs text-fg-muted">
                {inUse.map((nodeId) => (
                  <li key={nodeId}>{nodeId}</li>
                ))}
              </ul>
            )}
            <p className="text-fg-muted">
              Removing it anyway marks those nodes “provider missing” until another provider is
              chosen.
            </p>
          </div>
        )}
        {inUse === undefined && <ErrorLine error={remove.error} />}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={remove.isPending}
            onClick={() =>
              remove.mutate(
                { id: provider.id, ...(inUse === undefined ? {} : { confirm: true }) },
                { onSuccess: onClose },
              )
            }
          >
            {inUse === undefined ? 'Remove' : 'Remove anyway'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
