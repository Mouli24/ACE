import { expect, test } from '@playwright/test';

import { flowNode, freshApp, openWorkflow, seedGraph, serverGraph } from './helpers';

/**
 * The Tools UI (round 4 §5 item 6, §7.1): the `/library/tools` registry and MCP servers panel
 * (FR-TOOL-001/007) and the Agent node's per-tool enablement (FR-TOOL-002/006), covering TC-TOOL-001
 * and TC-TOOL-002 against the MSW mock engine and its fixture MCP server.
 *
 * Wiring note (integration, owned outside this feature's paths): `/library/tools` is registered in
 * `apps/web/src/app/routes.tsx` and the Agent panel renders `AgentToolsSection` in
 * `apps/web/src/config-panel/panels.tsx` (replacing the `LaterField` "Tools" placeholder). Until
 * both are wired these tests exercise the intended surface.
 */

test.describe('TC-TOOL-001 the tool registry and MCP servers (FR-TOOL-001/007)', () => {
  test('lists the built-ins with permissions, then an added MCP server contributes its tools', async ({
    page,
  }) => {
    await freshApp(page);
    await page.goto('/library/tools');

    await expect(page.getByRole('heading', { name: 'Tools', exact: true })).toBeVisible();
    const registry = page.getByTestId('tool-registry');

    // Every built-in has a row; the permission facts render where the contract sets them (§2.2).
    await expect(registry.getByTestId('tool-row-echo')).toBeVisible();
    await expect(
      registry.getByTestId('tool-row-http_request').getByTestId('perm-network'),
    ).toBeVisible();
    await expect(
      registry.getByTestId('tool-row-sandbox_delete').getByTestId('perm-destructive'),
    ).toBeVisible();
    await expect(registry.getByTestId('tool-row-code_sandbox')).toContainText('ms');

    // Connect the fixture MCP server; its two tools join the registry, attributed to the server.
    await page.getByRole('button', { name: /add server/i }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name').fill('files');
    await dialog.getByLabel('Command').fill('node');
    await dialog.getByRole('button', { name: 'Add server' }).click();
    await expect(dialog).toBeHidden();

    await expect(registry.getByTestId('tool-row-mcp_files_search')).toBeVisible();
    const mcpRow = registry.getByTestId('tool-row-mcp_files_echo');
    await expect(mcpRow).toBeVisible();
    await expect(mcpRow).toContainText('files');

    // The chip shows the server connected with its tool count.
    const chip = page.getByTestId(/^mcp-server-status-/);
    await expect(chip.first()).toHaveAttribute('data-status', 'connected');
    await expect(chip.first()).toContainText('2 tools');

    // Remove it → its tools leave the registry.
    await page.getByRole('button', { name: 'Remove files' }).click();
    await expect(registry.getByTestId('tool-row-mcp_files_search')).toBeHidden();
    await expect(registry.getByTestId('tool-row-echo')).toBeVisible();
  });
});

test.describe('TC-TOOL-002 tools are enabled per agent (FR-TOOL-002)', () => {
  test('enabling echo on an agent persists into tools.enabled; an absent tool has no toggle', async ({
    page,
  }) => {
    await freshApp(page);
    const seeded = await seedGraph(page, ['agent']);
    const agent = seeded.nodeIds[0]!;
    await openWorkflow(page, seeded);
    await flowNode(page, agent).click();

    const section = page.getByTestId('config-panel').getByTestId('agent-tools-section');
    await expect(section).toBeVisible();

    // Only registered tools have a toggle — an absent tool cannot be enabled.
    await expect(section.getByRole('checkbox', { name: 'echo' })).toBeVisible();
    await expect(section.getByRole('checkbox', { name: 'ghost_tool' })).toHaveCount(0);

    await section.getByRole('checkbox', { name: 'echo' }).click();

    await expect
      .poll(async () => {
        const graph = await serverGraph(page, seeded.workflowId);
        const config = graph.nodes.find((node) => node.id === agent)?.config as {
          tools?: { enabled?: string[] };
        };
        return config.tools?.enabled ?? [];
      })
      .toContain('echo');
  });
});
