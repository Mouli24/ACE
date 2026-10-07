import {
  BUNDLE_FORMAT,
  BUNDLE_FORMAT_VERSION,
  BundleFileSchema,
  type Bundle,
  type CreateMcpServerRequest,
  type Skill,
} from '@ace/contracts';
import { AceApiError } from '@ace/sdk';
import { Badge, Button, toast } from '@ace/ui';
import { Info, Package, PlugZap, Trash2, Upload } from 'lucide-react';
import { useRef, useState, type ChangeEvent } from 'react';

import { ConfirmDialog } from '../knowledge/ConfirmDialog';
import { useBundles, useDeleteBundle, useImportBundle, useSkills } from './skills-hooks';
import { useCreateMcpServer, useMcpServers } from './tools-hooks';

/** `Blob.text()` is missing in some environments; FileReader is everywhere. */
function readText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsText(file);
  });
}

/** Why a file is not a bundle, one line per problem, each naming where it is. */
export function bundleFileProblems(raw: unknown): string[] {
  const header = raw as { format?: unknown; formatVersion?: unknown } | null;
  if (header?.format === BUNDLE_FORMAT && header.formatVersion !== BUNDLE_FORMAT_VERSION) {
    return [
      `This bundle is format version ${String(header.formatVersion)}; this ACE reads version ${BUNDLE_FORMAT_VERSION}.`,
    ];
  }
  const parsed = BundleFileSchema.safeParse(raw);
  if (parsed.success) return [];
  return parsed.error.issues.map((issue) => {
    const where = issue.path.map(String).join('.');
    return where === '' ? issue.message : `${where}: ${issue.message}`;
  });
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

/** Where a server definition points: the command line of a stdio server, the URL of an http one. */
const addressOf = (server: CreateMcpServerRequest): string =>
  server.transport === 'stdio'
    ? [server.command ?? '', ...(server.args ?? [])].join(' ').trim()
    : (server.url ?? '');

/**
 * Library › Bundles (ACE parity P1, D273): import an `ace-bundle` JSON file, checked against the
 * contract here first; list each bundle with the skills it installed and the plugin (MCP server)
 * definitions it named. Importing connects nothing and enables nothing: each plugin has its own
 * Connect, through the existing MCP route, and skills are chosen per agent.
 */
export function BundlesTab() {
  const bundles = useBundles();
  const skills = useSkills();
  const servers = useMcpServers();
  const importBundle = useImportBundle();
  const input = useRef<HTMLInputElement>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [deleting, setDeleting] = useState<Bundle | null>(null);
  const remove = useDeleteBundle();

  const skillById = new Map((skills.data ?? []).map((skill) => [skill.id, skill]));
  const connectedNames = new Set((servers.data ?? []).map((server) => server.name));

  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setProblems([]);
    let raw: unknown;
    try {
      raw = JSON.parse(await readText(file));
    } catch {
      setProblems([`“${file.name}” is not valid JSON.`]);
      return;
    }
    const found = bundleFileProblems(raw);
    if (found.length > 0) {
      setProblems([`“${file.name}” is not a bundle ACE can import:`, ...found]);
      return;
    }
    importBundle.mutate(BundleFileSchema.parse(raw), {
      onSuccess: (bundle) =>
        toast.success(`Imported "${bundle.name}"`, {
          description: `${plural(bundle.skillIds.length, 'skill')} installed. Nothing was connected or enabled.`,
        }),
      onError: (error) =>
        setProblems([AceApiError.is(error) ? error.message : 'Could not import the bundle.']),
    });
  };

  const confirmDelete = () => {
    if (deleting === null) return;
    remove.mutate(deleting.id, {
      onSuccess: () => {
        toast.success(`Bundle "${deleting.name}" deleted`);
        setDeleting(null);
      },
    });
  };

  return (
    <section className="flex flex-col gap-4" data-testid="bundles-tab">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="font-human text-lg font-semibold">Bundles</h2>
          <p className="mt-1 font-human text-sm text-fg-muted">
            A bundle is a file that shares skills and plugin definitions with a team.
          </p>
        </div>
        <input
          ref={input}
          type="file"
          accept=".json,application/json"
          className="sr-only"
          aria-label="Bundle file"
          onChange={(event) => void onFile(event)}
        />
        <Button
          onClick={() => input.current?.click()}
          disabled={importBundle.isPending}
          className="self-start"
        >
          <Upload className="h-4 w-4" aria-hidden /> Import bundle
        </Button>
      </header>

      <p
        role="note"
        data-testid="bundles-note"
        className="flex items-start gap-2 rounded-card border border-border bg-panel px-4 py-3 font-human text-sm text-fg-soft"
      >
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-fg-muted" aria-hidden />
        <span>
          Importing a bundle installs its skills and lists its plugins. It connects nothing and
          enables nothing: connect each plugin when you trust it, and tick skills per agent.
        </span>
      </p>

      {problems.length > 0 && (
        <div
          role="alert"
          data-testid="bundle-problems"
          className="rounded-card border border-danger/50 px-4 py-3 text-sm text-danger"
        >
          <p>{problems[0]}</p>
          {problems.length > 1 && (
            <ul className="mt-1 list-disc pl-5 font-machine text-xs">
              {problems.slice(1).map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {bundles.isPending && <p className="text-fg-muted">Loading bundles…</p>}
      {bundles.isError && (
        <p role="alert" className="text-danger">
          Could not load bundles: {bundles.error.message}
        </p>
      )}
      {bundles.data?.length === 0 && (
        <div
          data-testid="bundles-empty"
          className="flex flex-col items-center gap-3 rounded-card border border-dashed border-border p-8 text-center"
        >
          <Package className="h-6 w-6 text-fg-muted" aria-hidden />
          <p className="font-human text-fg-muted">
            No bundles imported. Import an <span className="font-machine">ace-bundle</span> JSON
            file to install the skills it shares.
          </p>
        </div>
      )}

      {bundles.data && bundles.data.length > 0 && (
        <ul aria-label="Bundles" className="flex flex-col gap-3">
          {bundles.data.map((bundle) => (
            <BundleCard
              key={bundle.id}
              bundle={bundle}
              skillById={skillById}
              connectedNames={connectedNames}
              onDelete={() => setDeleting(bundle)}
            />
          ))}
        </ul>
      )}

      {deleting !== null && (
        <ConfirmDialog
          title={`Delete the bundle "${deleting.name}"?`}
          description={`Its ${plural(deleting.skillIds.length, 'skill')} are removed with it, and agents that use them are stopped at pre-flight. Plugins you connected stay connected.`}
          confirmLabel="Delete bundle"
          pending={remove.isPending}
          error={remove.error}
          onConfirm={confirmDelete}
          onClose={() => {
            remove.reset();
            setDeleting(null);
          }}
        />
      )}
    </section>
  );
}

function BundleCard({
  bundle,
  skillById,
  connectedNames,
  onDelete,
}: {
  bundle: Bundle;
  skillById: ReadonlyMap<string, Skill>;
  connectedNames: ReadonlySet<string>;
  onDelete: () => void;
}) {
  return (
    <li
      data-testid={`bundle-card-${bundle.id}`}
      className="flex flex-col gap-3 rounded-card border border-border bg-panel px-4 py-3"
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-human font-semibold">{bundle.name}</h3>
          {bundle.description !== '' && (
            <p className="font-human text-sm text-fg-muted">{bundle.description}</p>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Delete bundle ${bundle.name}`}
          onClick={onDelete}
        >
          <Trash2 className="h-4 w-4 text-danger" aria-hidden />
        </Button>
      </div>

      <div className="flex flex-col gap-1">
        <h4 className="font-machine text-[10px] uppercase tracking-wider text-fg-muted">
          Skills ({bundle.skillIds.length})
        </h4>
        {bundle.skillIds.length === 0 ? (
          <p className="text-xs text-fg-muted">This bundle shares no skills.</p>
        ) : (
          <ul className="flex flex-wrap gap-1.5" aria-label={`Skills of ${bundle.name}`}>
            {bundle.skillIds.map((id) => {
              const skill = skillById.get(id);
              return (
                <li key={id}>
                  <Badge variant={skill === undefined ? 'outline' : 'default'}>
                    {skill === undefined ? 'Removed skill' : skill.name}
                  </Badge>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <h4 className="font-machine text-[10px] uppercase tracking-wider text-fg-muted">
          Plugins ({bundle.mcpServers.length})
        </h4>
        {bundle.mcpServers.length === 0 ? (
          <p className="text-xs text-fg-muted">This bundle names no plugins.</p>
        ) : (
          <ul className="flex flex-col gap-1.5" aria-label={`Plugins of ${bundle.name}`}>
            {bundle.mcpServers.map((server) => (
              <PluginRow
                key={server.name}
                server={server}
                connected={connectedNames.has(server.name)}
              />
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}

/**
 * One plugin definition of a bundle. Connect registers it through `POST /mcp-servers`, exactly as
 * the Plugins tab's Add server does; once a server of that name is connected, it says so.
 */
function PluginRow({ server, connected }: { server: CreateMcpServerRequest; connected: boolean }) {
  const create = useCreateMcpServer();
  const connect = () =>
    create.mutate(server, {
      onSuccess: (created) =>
        toast.success(`Connected "${created.name}"`, {
          description:
            created.status === 'connected'
              ? `${plural(created.toolCount, 'tool')} joined the registry. Enable them per agent.`
              : `It is ${created.status}${created.error === undefined ? '' : `: ${created.error}`}.`,
        }),
    });

  return (
    <li
      data-testid={`bundle-plugin-${server.name}`}
      className="flex flex-wrap items-center gap-2 rounded-chip border border-border px-3 py-2"
    >
      <span className="font-human text-sm font-semibold">{server.name}</span>
      <span className="min-w-0 flex-1 truncate font-machine text-xs text-fg-muted">
        {server.transport} · {addressOf(server)}
      </span>
      {connected ? (
        <Badge data-testid={`bundle-plugin-connected-${server.name}`}>Connected</Badge>
      ) : (
        <Button
          variant="secondary"
          size="sm"
          onClick={connect}
          disabled={create.isPending}
          aria-label={`Connect ${server.name}`}
        >
          <PlugZap className="h-4 w-4" aria-hidden /> Connect
        </Button>
      )}
      {create.isError && (
        <p role="alert" className="w-full text-xs text-danger">
          {AceApiError.is(create.error) ? create.error.message : 'Could not connect the plugin.'}
        </p>
      )}
    </li>
  );
}
