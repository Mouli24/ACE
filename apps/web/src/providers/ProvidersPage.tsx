import {
  DEFAULT_CLI_PERMISSION,
  isCliProviderType,
  type Provider,
  type ProviderGroup,
} from '@ace/contracts';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Icons,
  ProviderStatusChip,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@ace/ui';
import { useState, type ReactNode } from 'react';

import { clockTime } from '../theme/format';
import { ModelsTab } from './ModelsTab';
import { AddProviderDialog, DeleteProviderDialog, EditProviderDialog } from './ProviderDialogs';
import { LocalModelsList, PullModelHint } from './ProviderModelPicker';
import { ProviderMark } from './ProviderMark';
import { groupProviders } from './provider-groups';
import { useCheckProvider, useProviderDetect, useProviders } from './hooks';
import { CLI_PERMISSION_LABEL, PROVIDER_TYPE_LABEL } from './provider-meta';

type DialogState =
  | { kind: 'add' }
  | { kind: 'edit'; provider: Provider }
  | { kind: 'delete'; provider: Provider }
  | undefined;

/**
 * `/providers` (round 2 §5 steps 2 and 4): the provider list and the model catalog, side by side
 * as two tabs. Nothing here ever holds a key — a provider's row says only whether one is stored
 * (FR-PRV-002). An uncovered screen in the Ace UI theme (D328): page title, theme cards with the
 * provider's orb, segmented tabs.
 */
export function ProvidersPage() {
  const providers = useProviders();
  const detect = useProviderDetect();
  const [dialog, setDialog] = useState<DialogState>();

  const ollama = detect.data?.ollama;
  const ollamaAlreadyAdded = providers.data?.some((provider) => provider.type === 'ollama');

  return (
    <main className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[960px] flex-col gap-6 px-6 py-8">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-[20px] font-bold tracking-[-0.01em]">Providers &amp; models</h1>
          <Button onClick={() => setDialog({ kind: 'add' })}>Add provider</Button>
        </header>

        {/* FR-PRV-007: a local Ollama found on its default address is offered, not added silently. */}
        {ollama?.detected && !ollamaAlreadyAdded && (
          <div
            data-testid="ollama-detected"
            className="flex flex-wrap items-center gap-3 rounded-[12px] border border-[var(--line)] bg-[var(--surface)] p-3"
          >
            <ProviderMark type="ollama" />
            <span className="min-w-0 flex-1 text-[13px]">
              Ollama detected at <span className="font-machine text-[12px]">{ollama.baseUrl}</span>
            </span>
            <Button variant="secondary" size="sm" onClick={() => setDialog({ kind: 'add' })}>
              Add it
            </Button>
          </div>
        )}

        <Tabs defaultValue="providers" className="flex min-h-0 flex-col gap-4">
          <TabsList className="self-start">
            <TabsTrigger value="providers">Providers</TabsTrigger>
            <TabsTrigger value="models">Models</TabsTrigger>
          </TabsList>

          <TabsContent value="providers" className="flex flex-col gap-[10px]">
            {providers.isPending && (
              <p className="text-[13px] text-[var(--muted)]">Loading providers…</p>
            )}
            {providers.isError && (
              <p role="alert" className="text-[12px] text-[#c94c27]">
                Could not load providers: {providers.error.message}
              </p>
            )}
            {providers.data?.length === 0 && (
              <p className="py-10 text-center text-[13px] text-[var(--muted)]">
                No providers yet. Add one — the mock provider needs no key and runs offline.
              </p>
            )}
            {/* PG-1.4: the providers in their sections; Local & open models is always shown. */}
            {providers.data !== undefined &&
              groupProviders(providers.data, ['local']).map((section) => (
                <ProviderSectionView
                  key={section.group}
                  group={section.group}
                  label={section.label}
                  providers={section.providers}
                  onAction={setDialog}
                />
              ))}
          </TabsContent>

          <TabsContent value="models">
            <ModelsTab providers={providers.data ?? []} />
          </TabsContent>
        </Tabs>
      </div>

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

/**
 * One PG-1.4 section — Cloud APIs, Local & open models, CLI agents, Custom endpoints, Test
 * providers. Local & open models also lists what each runtime has on this machine (size,
 * tools/JSON, "Free · runs on your machine"), and says how to pull a model when there is none.
 */
function ProviderSectionView({
  group,
  label,
  providers,
  onAction,
}: {
  group: ProviderGroup;
  label: string;
  providers: Provider[];
  onAction: (dialog: DialogState) => void;
}) {
  const headingId = `provider-section-${group}`;
  return (
    <section
      aria-labelledby={headingId}
      data-testid={`provider-section-${group}`}
      className="flex flex-col gap-[8px]"
    >
      <h2
        id={headingId}
        className="mt-2 font-machine text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--muted)]"
      >
        {label}
      </h2>
      {group === 'local' && providers.length === 0 && (
        <div className="rounded-[12px] border border-dashed border-[var(--line)] p-3">
          <p className="text-[12.5px]">
            No local runtime added yet. Models from Ollama or LM Studio run on your machine, for
            free.
          </p>
          <PullModelHint className="mt-1" />
        </div>
      )}
      <ul className="flex flex-col gap-[10px]">
        {providers.map((provider) => (
          <ProviderRow key={provider.id} provider={provider} onAction={onAction}>
            {group === 'local' && <LocalModelsList provider={provider} />}
          </ProviderRow>
        ))}
      </ul>
    </section>
  );
}

/** One provider as a theme card (the Team aside's agent card): orb, name, mono details, actions. */
function ProviderRow({
  provider,
  onAction,
  children,
}: {
  provider: Provider;
  onAction: (dialog: DialogState) => void;
  /** Shown under the row's own line: a local runtime's models (PG-1.4). */
  children?: ReactNode;
}) {
  const check = useCheckProvider();

  return (
    <li
      data-testid={`provider-row-${provider.id}`}
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[12px] border border-[var(--line)] bg-[var(--surface)] p-3"
    >
      <ProviderMark type={provider.type} />
      <div className="min-w-0 flex-1">
        <p
          className="truncate text-[13.5px] font-bold"
          data-testid={`provider-name-${provider.id}`}
        >
          {provider.name}
        </p>
        <p className="mt-px truncate font-machine text-[10px] text-[var(--muted)]">
          {PROVIDER_TYPE_LABEL[provider.type]}
          {provider.baseUrl ? ` · ${provider.baseUrl}` : ''} · {provider.concurrency} concurrent
        </p>
      </div>

      {isCliProviderType(provider.type) ? (
        <span
          className="font-machine text-[10px] text-[var(--muted)]"
          data-testid={`provider-permission-${provider.id}`}
        >
          permission: {CLI_PERMISSION_LABEL[provider.cliPermission ?? DEFAULT_CLI_PERMISSION]}
        </span>
      ) : (
        /* FR-PRV-002: whether a key exists, never the key. */
        <span
          className="font-machine text-[10px] text-[var(--muted)]"
          data-testid={`provider-key-set-${provider.id}`}
        >
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

      <span className="font-machine text-[10px] text-[var(--muted)]">
        {provider.lastCheckedAt ? `checked ${clockTime(provider.lastCheckedAt)}` : 'never checked'}
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
          <button
            type="button"
            aria-label={`Actions for ${provider.name}`}
            className="grid h-6 cursor-pointer place-items-center rounded-full border border-[var(--line)] bg-[var(--soft)] px-[9px] text-[var(--ink)] outline-none hover:bg-[var(--hover)] focus-visible:border-[#ef6b3f]"
          >
            <Icons.Ellipsis aria-hidden size={14} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => onAction({ kind: 'edit', provider })}>
            Edit
          </DropdownMenuItem>
          <DropdownMenuItem destructive onSelect={() => onAction({ kind: 'delete', provider })}>
            Remove
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {children !== undefined && children !== false && (
        <div className="basis-full pl-[32px]">{children}</div>
      )}
    </li>
  );
}
