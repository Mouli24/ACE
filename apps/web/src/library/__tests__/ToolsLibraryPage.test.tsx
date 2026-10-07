import { BUILTIN_TOOL_NAMES } from '@ace/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { serverSlug } from '../../mocks/tools-catalog';
import { ToolsTab } from '../ToolsLibraryPage';
import { db, installToolsMockServer, renderTools, startToolsSocket } from './harness';

installToolsMockServer();

/** Add an MCP server through the dialog; defaults to a reachable stdio server. */
async function addServer(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(await screen.findByRole('button', { name: /add server/i }));
  const dialog = await screen.findByRole('dialog');
  await user.type(within(dialog).getByLabelText('Name'), name);
  await user.type(within(dialog).getByLabelText('Command'), 'node');
  await user.click(within(dialog).getByRole('button', { name: 'Add server' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
}

describe('TC-TOOL-001 the registry lists built-ins and MCP tools with their permissions', () => {
  it('shows every built-in with source and permission badges', async () => {
    renderTools(<ToolsTab />);

    // Every contract built-in has a row (FR-TOOL-001).
    for (const name of BUILTIN_TOOL_NAMES) {
      const row = await screen.findByTestId(`tool-row-${name}`);
      expect(row).toHaveAttribute('data-source', 'builtin');
    }

    // The three permission facts render where the contract sets them (§2.2).
    const httpRow = screen.getByTestId('tool-row-http_request');
    expect(within(httpRow).getByTestId('perm-network')).toBeInTheDocument();

    const deleteRow = screen.getByTestId('tool-row-sandbox_delete');
    expect(within(deleteRow).getByTestId('perm-destructive')).toBeInTheDocument();
    expect(within(deleteRow).getByTestId('perm-fs')).toBeInTheDocument();

    const echoRow = screen.getByTestId('tool-row-echo');
    expect(within(echoRow).getByText('builtin')).toBeInTheDocument();
    expect(within(echoRow).getByText('5000 ms')).toBeInTheDocument();
  });

  it('adds a connected MCP server, whose tools join the registry with the server name as source', async () => {
    const user = userEvent.setup();
    renderTools(<ToolsTab />);
    await screen.findByTestId('tool-row-echo');

    await addServer(user, 'files');

    // The two fixture tools appear, prefixed and attributed to the server (FR-TOOL-007, D16).
    const slug = serverSlug('files');
    const mcpRow = await screen.findByTestId(`tool-row-mcp_${slug}_search`);
    expect(mcpRow).toHaveAttribute('data-source', 'mcp');
    expect(within(mcpRow).getByText('files')).toBeInTheDocument();
    expect(screen.getByTestId(`tool-row-mcp_${slug}_echo`)).toBeInTheDocument();
  });
});

describe('FR-TOOL-007 MCP servers connect, show status and tool count, and can be removed', () => {
  it('connects a stdio server with tool count 2', async () => {
    const user = userEvent.setup();
    renderTools(<ToolsTab />);
    await addServer(user, 'files');

    await waitFor(() => expect(db.listMcpServers()).toHaveLength(1));
    const created = db.listMcpServers()[0]!;
    const chip = await screen.findByTestId(`mcp-server-status-${created.id}`);
    expect(chip).toHaveAttribute('data-status', 'connected');
    expect(within(chip).getByTestId('mcp-toolcount-files')).toHaveTextContent('2 tools');
  });

  it('shows an unreachable server (a name containing "unreachable") with an error, no tools', async () => {
    const user = userEvent.setup();
    renderTools(<ToolsTab />);
    await addServer(user, 'unreachable-one');

    await waitFor(() => expect(db.listMcpServers()).toHaveLength(1));
    const created = db.listMcpServers()[0]!;
    const chip = await screen.findByTestId(`mcp-server-status-${created.id}`);
    expect(chip).toHaveAttribute('data-status', 'unreachable');
    // Its tools never joined the registry.
    const slug = serverSlug('unreachable-one');
    expect(screen.queryByTestId(`tool-row-mcp_${slug}_search`)).not.toBeInTheDocument();
  });

  it('removes a server and its tools leave the registry', async () => {
    const user = userEvent.setup();
    renderTools(<ToolsTab />);
    await addServer(user, 'files');

    const slug = serverSlug('files');
    await screen.findByTestId(`tool-row-mcp_${slug}_search`);
    const created = db.listMcpServers()[0]!;

    await user.click(screen.getByTestId(`mcp-server-remove-${created.id}`));

    await waitFor(() =>
      expect(screen.queryByTestId(`tool-row-mcp_${slug}_search`)).not.toBeInTheDocument(),
    );
    expect(screen.queryByTestId(`mcp-server-row-${created.id}`)).not.toBeInTheDocument();
  });

  it('re-checks a server on demand', async () => {
    const user = userEvent.setup();
    renderTools(<ToolsTab />);
    await addServer(user, 'files');
    const created = db.listMcpServers()[0]!;
    const firstCheckedAt = created.lastCheckedAt;

    await user.click(screen.getByTestId(`mcp-server-check-${created.id}`));

    await waitFor(() =>
      expect(db.getMcpServer(created.id)?.lastCheckedAt).not.toBe(firstCheckedAt),
    );
  });
});

describe('FR-TOOL-007 mcp.status keeps the chip current without a reload', () => {
  it('folds an engine-scope mcp.status frame into the registry', async () => {
    const user = userEvent.setup();
    startToolsSocket();
    renderTools(<ToolsTab />);
    await addServer(user, 'files');

    const created = db.listMcpServers()[0]!;
    await screen.findByTestId(`mcp-server-status-${created.id}`);

    // The engine reports the server gone; the screen follows (BR-01), no refetch call of ours.
    db.updateMcpServer(created.id, { status: 'unreachable', toolCount: 0 });
    db.emit({
      type: 'mcp.status',
      payload: { serverId: created.id, status: 'unreachable', toolCount: 0 },
      scope: 'engine',
    });

    await waitFor(() =>
      expect(screen.getByTestId(`mcp-server-status-${created.id}`)).toHaveAttribute(
        'data-status',
        'unreachable',
      ),
    );
  });
});
