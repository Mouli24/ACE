import {
  MCP_SERVER_NAME_MAX,
  MCP_TRANSPORTS,
  type CreateMcpServerRequest,
  type McpServer,
  type McpTransport,
} from '@ace/contracts';
import { AceApiError } from '@ace/sdk';
import {
  Button,
  DIALOG_CLOSE_CLASS,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Icons,
  Input,
  Label,
  McpServerStatusChip,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@ace/ui';
import { useState, type FormEvent } from 'react';

import {
  useCheckMcpServer,
  useCreateMcpServer,
  useDeleteMcpServer,
  useMcpServers,
} from './tools-hooks';

/**
 * The MCP servers panel (round 4 §5 item 6, FR-TOOL-007, D16): connect a server over stdio (a
 * command + arguments) or http (a URL), see its liveness and tool count, re-check it, and remove it.
 * A connected server's tools appear in the registry table above; removing it takes them back out.
 * `mcp.status` keeps the chip current without a reload (wired by the page). Theme cards (D328).
 */
export function McpServersPanel() {
  const servers = useMcpServers();
  const [adding, setAdding] = useState(false);

  return (
    <section className="flex flex-col gap-3" data-testid="mcp-servers-panel">
      <header className="flex items-center justify-between">
        <div>
          <h2 className="text-[14px] font-bold">MCP servers</h2>
          <p className="mt-0.5 text-[11px] leading-[1.45] text-[var(--muted)]">
            Connected servers contribute their tools to the registry (FR-TOOL-007).
          </p>
        </div>
        <Button size="sm" onClick={() => setAdding(true)}>
          Add server
        </Button>
      </header>

      {servers.isPending && <p className="text-[13px] text-[var(--muted)]">Loading servers…</p>}
      {servers.isError && (
        <p role="alert" className="text-[12px] text-danger">
          Could not load MCP servers: {servers.error.message}
        </p>
      )}
      {servers.data?.length === 0 && (
        <p className="py-8 text-center text-[13px] text-[var(--muted)]">
          No MCP servers connected.
        </p>
      )}

      <ul className="flex flex-col gap-[10px]">
        {servers.data?.map((server) => (
          <McpServerRow key={server.id} server={server} />
        ))}
      </ul>

      {adding && <AddMcpServerDialog onClose={() => setAdding(false)} />}
    </section>
  );
}

function McpServerRow({ server }: { server: McpServer }) {
  const check = useCheckMcpServer();
  const remove = useDeleteMcpServer();
  const address = server.transport === 'stdio' ? server.command : server.url;

  return (
    <li
      data-testid={`mcp-server-row-${server.id}`}
      className="flex items-center gap-3 rounded-[12px] border border-[var(--line)] bg-[var(--surface)] p-3"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <McpServerStatusChip
            data-testid={`mcp-server-status-${server.id}`}
            name={server.name}
            status={server.status}
            toolCount={server.toolCount}
          />
        </div>
        <p className="mt-1 truncate font-machine text-[10px] text-[var(--muted)]">
          {server.transport}
          {address ? ` · ${address}` : ''}
        </p>
        {server.error && (
          <p role="alert" className="mt-1 text-[11px] leading-[1.45] text-danger">
            {server.error}
          </p>
        )}
      </div>

      <Button
        variant="secondary"
        size="sm"
        disabled={check.isPending}
        onClick={() => check.mutate(server.id)}
        data-testid={`mcp-server-check-${server.id}`}
      >
        <Icons.RotateCw aria-hidden size={12} /> Check
      </Button>
      <button
        type="button"
        className={`${DIALOG_CLOSE_CLASS} text-danger disabled:cursor-not-allowed disabled:opacity-50`}
        aria-label={`Remove ${server.name}`}
        disabled={remove.isPending}
        onClick={() => remove.mutate(server.id)}
        data-testid={`mcp-server-remove-${server.id}`}
      >
        <Icons.X aria-hidden size={12} />
      </button>
    </li>
  );
}

const TRANSPORT_LABEL: Record<McpTransport, string> = {
  stdio: 'stdio (command)',
  http: 'http (URL)',
};

/**
 * Add an MCP server (FR-TOOL-007). The transport decides which address field is required: a stdio
 * server takes a command and space-separated arguments, an http server takes a URL. The engine
 * validates the pair (`CreateMcpServerRequest`) and answers the created server with its status.
 */
function AddMcpServerDialog({ onClose }: { onClose: () => void }) {
  const create = useCreateMcpServer();
  const [name, setName] = useState('');
  const [transport, setTransport] = useState<McpTransport>('stdio');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [url, setUrl] = useState('');

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmedArgs = args.trim();
    const body: CreateMcpServerRequest =
      transport === 'stdio'
        ? {
            name: name.trim(),
            transport,
            command: command.trim(),
            ...(trimmedArgs === '' ? {} : { args: trimmedArgs.split(/\s+/) }),
          }
        : { name: name.trim(), transport, url: url.trim() };
    create.mutate(body, { onSuccess: onClose });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Add MCP server</DialogTitle>
            <DialogDescription>
              Connect a Model Context Protocol server; its tools join the registry (FR-TOOL-007).
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-[7px]">
            <Label htmlFor="mcp-name">Name</Label>
            <Input
              id="mcp-name"
              value={name}
              maxLength={MCP_SERVER_NAME_MAX}
              onChange={(event) => setName(event.target.value)}
              placeholder="my-tools"
            />
          </div>

          <div className="flex flex-col gap-[7px]">
            <Label htmlFor="mcp-transport">Transport</Label>
            <Select
              value={transport}
              onValueChange={(value) => setTransport(value as McpTransport)}
            >
              <SelectTrigger id="mcp-transport" aria-label="Transport">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MCP_TRANSPORTS.map((value) => (
                  <SelectItem key={value} value={value}>
                    {TRANSPORT_LABEL[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {transport === 'stdio' ? (
            <>
              <div className="flex flex-col gap-[7px]">
                <Label htmlFor="mcp-command">Command</Label>
                <Input
                  id="mcp-command"
                  value={command}
                  onChange={(event) => setCommand(event.target.value)}
                  placeholder="node"
                  className="font-machine text-[12px]"
                />
              </div>
              <div className="flex flex-col gap-[7px]">
                <Label htmlFor="mcp-args">Arguments</Label>
                <Input
                  id="mcp-args"
                  value={args}
                  onChange={(event) => setArgs(event.target.value)}
                  placeholder="server.js --stdio"
                  className="font-machine text-[12px]"
                />
                <p className="text-[11px] leading-[1.45] text-[var(--muted)]">
                  Space-separated; optional.
                </p>
              </div>
            </>
          ) : (
            <div className="flex flex-col gap-[7px]">
              <Label htmlFor="mcp-url">URL</Label>
              <Input
                id="mcp-url"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="http://127.0.0.1:8000/mcp"
                className="font-machine text-[12px]"
              />
            </div>
          )}

          {create.isError && (
            <p role="alert" className="text-[12px] text-danger">
              {AceApiError.is(create.error)
                ? create.error.message
                : 'Could not add the MCP server.'}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending}>
              Add server
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
