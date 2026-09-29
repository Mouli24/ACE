import type { AgentConfig } from '@ace/contracts';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { AgentToolsSection, isValidHost } from '../../config-panel/AgentToolsSection';
import { installToolsMockServer, renderTools } from './harness';

installToolsMockServer();

type ToolsConfig = AgentConfig['tools'];
const baseTools = (over: Partial<ToolsConfig> = {}): ToolsConfig => ({
  enabled: [],
  maxToolCalls: 10,
  allowedDomains: [],
  ...over,
});

/** The latest `tools` object a spy `onChange` was called with. */
function lastCall(onChange: ReturnType<typeof vi.fn>): ToolsConfig {
  return onChange.mock.calls.at(-1)![0] as ToolsConfig;
}

describe('TC-TOOL-002 tools are enabled per agent and the enabled set is what persists', () => {
  it('enables echo → onChange carries it in tools.enabled', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderTools(<AgentToolsSection tools={baseTools()} onChange={onChange} />);

    await user.click(await screen.findByRole('checkbox', { name: 'echo' }));

    expect(lastCall(onChange).enabled).toContain('echo');
  });

  it('disables an enabled tool → onChange drops it', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderTools(<AgentToolsSection tools={baseTools({ enabled: ['echo'] })} onChange={onChange} />);

    await user.click(await screen.findByRole('checkbox', { name: 'echo' }));

    expect(lastCall(onChange).enabled).not.toContain('echo');
  });

  it('a tool the registry does not offer cannot be enabled, and shows tool_not_registered', async () => {
    const onChange = vi.fn();
    renderTools(
      <AgentToolsSection tools={baseTools({ enabled: ['ghost_tool'] })} onChange={onChange} />,
    );

    // The absent tool has no row to toggle — only registry tools do.
    await screen.findByRole('checkbox', { name: 'echo' });
    expect(screen.queryByRole('checkbox', { name: 'ghost_tool' })).not.toBeInTheDocument();

    // …and it is surfaced as the pre-flight code, not silently kept (FR-TOOL-002).
    const warning = screen.getByTestId('tools-not-registered');
    expect(warning).toHaveTextContent('tool_not_registered');
    expect(warning).toHaveTextContent('ghost_tool');
  });

  it('warns that an enabled destructive tool waits for approval (FR-GRD-006)', async () => {
    renderTools(
      <AgentToolsSection tools={baseTools({ enabled: ['sandbox_delete'] })} onChange={vi.fn()} />,
    );
    expect(
      await screen.findByTestId('tool-destructive-warning-sandbox_delete'),
    ).toBeInTheDocument();
  });
});

describe('FR-TOOL-006 the call limit and the allowed-domains list', () => {
  it('commits a new max tool calls', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderTools(<AgentToolsSection tools={baseTools()} onChange={onChange} />);

    const input = await screen.findByLabelText('Max tool calls');
    await user.clear(input);
    await user.type(input, '5');
    await user.tab();

    await waitFor(() => expect(lastCall(onChange).maxToolCalls).toBe(5));
  });

  it('adds a valid host and refuses one with a scheme', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderTools(<AgentToolsSection tools={baseTools()} onChange={onChange} />);

    const input = await screen.findByPlaceholderText('example.com');
    await user.type(input, 'https://example.com{Enter}');
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/no scheme or path/i);

    await user.clear(input);
    await user.type(input, 'api.example.com{Enter}');
    expect(lastCall(onChange).allowedDomains).toEqual(['api.example.com']);
  });

  it('removes a host', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderTools(
      <AgentToolsSection tools={baseTools({ allowedDomains: ['a.example.com'] })} onChange={onChange} />,
    );

    await user.click(await screen.findByRole('button', { name: 'Remove a.example.com' }));
    expect(lastCall(onChange).allowedDomains).toEqual([]);
  });
});

describe('isValidHost', () => {
  it.each(['example.com', 'api.example.com', 'localhost', '127.0.0.1', '127.0.0.1:8080'])(
    'accepts %s',
    (host) => expect(isValidHost(host)).toBe(true),
  );
  it.each(['https://example.com', 'example.com/path', 'has space', '', ' '])(
    'rejects %s',
    (host) => expect(isValidHost(host)).toBe(false),
  );
});
