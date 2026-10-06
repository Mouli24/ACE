import { DEFAULT_CLI_PERMISSION, isCliProviderType, type Provider } from '@ace/contracts';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  ProviderStatusChip,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@ace/ui';
import { MoreHorizontal, Plug, Plus } from 'lucide-react';
import { useState } from 'react';

import { ModelsTab } from './ModelsTab';
import { AddProviderDialog, DeleteProviderDialog, EditProviderDialog } from './ProviderDialogs';
import { useCheckProvider, useProviderDetect, useProviders } from './hooks';
import { CLI_PERMISSION_LABEL, PROVIDER_TYPE_LABEL, providerAccent } from './provider-meta';

type DialogState =
  | { kind: 'add' }
  | { kind: 'edit'; provider: Provider }
  | { kind: 'delete'; provider: Provider }
  | undefined;

/**
 * `/providers` (round 2 §5 steps 2 and 4): the provider list and the model catalog, side by side
 * as two tabs. Nothing here ever holds a key — a provider's row says only whether one is stored
 * (FR-PRV-002).
 */
export function ProvidersPage() {
  const providers = useProviders();
  const detect = useProviderDetect();
  const [dialog, setDialog] = useState<DialogState>();

  const ollama = detect.data?.ollama;
  const ollamaAlreadyAdded = providers.data?.some((provider) => provider.type === 'ollama');

  return (
    <main className="mx-auto flex h-full w-full max-w-5xl flex-col gap-6 overflow-y-auto px-4 py-10">
      <header className="flex items-center justify-between">
        <h1 className="font-human text-2xl font-semibold">Providers &amp; models</h1>
        <Button onClick={() => setDialog({ kind: 'add' })}>
          <Plus className="h-4 w-4" /> Add provider
        </Button>
      </header>

      {/* FR-PRV-007: a local Ollama found on its default address is offered, not added silently. */}
      {ollama?.detected && !ollamaAlreadyAdded && (
        <div
          data-testid="ollama-detected"
          className="flex items-center gap-3 rounded-card border border-border bg-card px-4 py-3 text-sm"
        >
          <Plug className="h-4 w-4 text-fg-muted" />
          <span className="flex-1">
            Ollama detected at <span className="font-machine">{ollama.baseUrl}</span>
          </span>
          <Button variant="secondary" size="sm" onClick={() => setDialog({ kind: 'add' })}>
            Add it
          </Button>
        </div>
      )}

      <Tabs defaultValue="providers" className="flex min-h-0 flex-col gap-4">
        <TabsList>
          <TabsTrigger value="providers">Providers</TabsTrigger>
          <TabsTrigger value="models">Models</TabsTrigger>
        </TabsList>

        <TabsContent value="providers" className="flex flex-col gap-2">
          {providers.isPending && <p className="text-fg-muted">Loading providers…</p>}
          {providers.isError && (
            <p role="alert" className="text-danger">
              Could not load providers: {providers.error.message}
            </p>
          )}
          {providers.data?.length === 0 && (
            <p className="rounded-card border border-dashed border-border p-8 text-center text-fg-muted">
              No providers yet. Add one — the mock provider needs no key and runs offline.
            </p>
          )}
          <ul className="flex flex-col gap-2">
            {providers.data?.map((provider) => (
              <ProviderRow key={provider.id} provider={provider} onAction={setDialog} />
            ))}
          </ul>
        </TabsContent>

        <TabsContent value="models">
          <ModelsTab providers={providers.data ?? []} />
        </TabsContent>
      </Tabs>

      {dialog?.kind === 'add' && (
        <AddProviderDialog
          onClose={() => setDialog(undefined)}
          {...(ollama?.detected ? { detectedOllamaBaseUrl: ollama.baseUrl } : {})}
        />
      )}
      {dialog?.kind === 'edit' && (
        <EditProviderDialog provider={dialog.provider} onClose={() => setDialog(undefined)} />
      )}
      {dialog?.kind === 'delete' && (
        <DeleteProviderDialog provider={dialog.provider} onClose={() => setDialog(undefined)} />
      )}
    </main>
  );
}

function ProviderRow({
  provider,
  onAction,
}: {
  provider: Provider;
  onAction: (dialog: DialogState) => void;
}) {
  const check = useCheckProvider();

  return (
    <li
      data-testid={`provider-row-${provider.id}`}
      className="flex items-center gap-3 rounded-card border border-border bg-panel px-4 py-3"
      style={{ borderLeft: `3px solid ${providerAccent(provider.type)}` }}
    >
      <div className="min-w-0 flex-1">
        <p className="truncate font-human text-base" data-testid={`provider-name-${provider.id}`}>
          {provider.name}
        </p>
        <p className="font-machine text-xs text-fg-muted">
          {PROVIDER_TYPE_LABEL[provider.type]}
          {provider.baseUrl ? ` · ${provider.baseUrl}` : ''} · {provider.concurrency} concurrent
        </p>
      </div>

      {isCliProviderType(provider.type) ? (
        <span className="font-machine text-xs" data-testid={`provider-permission-${provider.id}`}>
          permission: {CLI_PERMISSION_LABEL[provider.cliPermission ?? DEFAULT_CLI_PERMISSION]}
        </span>
      ) : (
        /* FR-PRV-002: whether a key exists, never the key. */
        <span className="font-machine text-xs" data-testid={`provider-key-set-${provider.id}`}>
          key set: {provider.keySet ? 'yes' : 'no'}
        </span>
      )}

      <ProviderStatusChip
        data-testid={`provider-status-${provider.id}`}
        name={provider.name}
        status={provider.status}
        {...(provider.statusMessage === undefined ? {} : { message: provider.statusMessage })}
        {...(provider.lastCheckedAt === undefined ? {} : { lastCheckedAt: provider.lastCheckedAt })}
      />

      <span className="w-32 text-right font-machine text-xs text-fg-muted">
        {provider.lastCheckedAt
          ? `checked ${new Date(provider.lastCheckedAt).toLocaleTimeString()}`
          : 'never checked'}
      </span>

      <Button
        variant="secondary"
        size="sm"
        disabled={check.isPending}
        onClick={() => check.mutate(provider.id)}
      >
        Test
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label={`Actions for ${provider.name}`}>
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => onAction({ kind: 'edit', provider })}>
            Edit
          </DropdownMenuItem>
          <DropdownMenuItem
            className="text-danger"
            onSelect={() => onAction({ kind: 'delete', provider })}
          >
            Remove
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}
