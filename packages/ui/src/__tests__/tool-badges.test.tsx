import { MCP_SERVER_STATUSES, type ToolPermissions } from '@ace/contracts';
import { render, screen } from '@testing-library/react';

import { McpServerStatusChip, ToolPermissionBadges } from '../components/tool-badges.js';

const perms = (overrides: Partial<ToolPermissions> = {}): ToolPermissions => ({
  network: false,
  fsPaths: [],
  destructive: false,
  ...overrides,
});

describe('FR-TOOL-001 tool permission badges', () => {
  it('shows a network badge when the tool reaches the network', () => {
    render(<ToolPermissionBadges permissions={perms({ network: true })} />);
    expect(screen.getByTestId('perm-network')).toHaveTextContent('network');
  });

  it('shows one badge per fs path', () => {
    render(<ToolPermissionBadges permissions={perms({ fsPaths: ['/sandbox/run', '/tmp'] })} />);
    expect(screen.getAllByTestId('perm-fs')).toHaveLength(2);
  });

  it('marks a destructive tool with the warning colour', () => {
    render(<ToolPermissionBadges permissions={perms({ destructive: true })} />);
    const badge = screen.getByTestId('perm-destructive');
    expect(badge).toHaveTextContent('destructive');
    expect(badge.className).toContain('text-danger');
  });

  it('shows a neutral "sandboxed" badge when a tool has no permissions', () => {
    render(<ToolPermissionBadges permissions={perms()} />);
    expect(screen.getByTestId('perm-none')).toBeInTheDocument();
  });

  it('can suppress the none badge', () => {
    render(<ToolPermissionBadges permissions={perms()} showNone={false} />);
    expect(screen.queryByTestId('perm-none')).not.toBeInTheDocument();
  });
});

describe('FR-TOOL-007 MCP server status chip', () => {
  it('renders every MCP status with its label and data-status', () => {
    for (const status of MCP_SERVER_STATUSES) {
      const { unmount } = render(<McpServerStatusChip name="fs" status={status} />);
      const chip = screen.getByTestId('mcp-chip-fs');
      expect(chip).toHaveAttribute('data-status', status);
      unmount();
    }
  });

  it('shows the name and tool count, singular when one', () => {
    const { rerender } = render(<McpServerStatusChip name="fs" status="connected" toolCount={3} />);
    expect(screen.getByTestId('mcp-chip-fs')).toHaveTextContent('fs');
    expect(screen.getByTestId('mcp-toolcount-fs')).toHaveTextContent('3 tools');
    rerender(<McpServerStatusChip name="fs" status="connected" toolCount={1} />);
    expect(screen.getByTestId('mcp-toolcount-fs')).toHaveTextContent('1 tool');
  });
});
