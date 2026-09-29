import type { AgentConfig } from '@ace/contracts';
import { Button, Checkbox, Input, Label, ToolPermissionBadges } from '@ace/ui';
import { TriangleAlert, X } from 'lucide-react';
import { useMemo, useState, type KeyboardEvent } from 'react';

import { useTools } from '../library/tools-hooks';
import { Field, NumberField } from './fields';
import type { NumberRange } from './validation';

/**
 * The Agent node's "Tools" config section (round 4 §5 item 6, FR-TOOL-002/006). Which tools the
 * agent may call is a set of names it keeps in `AgentConfig.tools.enabled`; the call limit and the
 * allow-listed domains live beside it. The registry (`GET /tools`) decides what can be enabled — a
 * name still in `enabled` that the registry no longer offers is shown as `tool_not_registered`, the
 * same code pre-flight raises for it (validation.ts), so a removed MCP server's tool is visible
 * rather than silent.
 *
 * Every edit patches the whole `tools` object at once, the way the other Agent fields patch theirs.
 */

/** `AgentConfig.tools`: `{ enabled, maxToolCalls, allowedDomains }`. */
type ToolsConfig = AgentConfig['tools'];

/** The contract's own bound on the call limit (`graph.ts`: `min(0).max(50)`). */
const MAX_TOOL_CALLS_RANGE: NumberRange = { min: 0, max: 50, integer: true };

/**
 * A host the `domain_allowlist` guardrail compares a request URL's host against (FR-TOOL-006). A
 * hostname or IPv4, with an optional port — never a scheme or a path, which is what a URL host is.
 */
const HOST_REGEX =
  /^(?:(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(?::\d{1,5})?$/;

export function isValidHost(value: string): boolean {
  const host = value.trim();
  if (host === '' || host.length > 255) return false;
  return HOST_REGEX.test(host);
}

export function AgentToolsSection({
  tools,
  onChange,
}: {
  tools: ToolsConfig;
  onChange: (tools: ToolsConfig) => void;
}) {
  const registry = useTools();

  const registryNames = useMemo(
    () => new Set((registry.data ?? []).map((tool) => tool.name)),
    [registry.data],
  );
  /** Enabled names the registry no longer offers (FR-TOOL-002, `tool_not_registered`). */
  const missing = tools.enabled.filter((name) => !registryNames.has(name));

  const toggle = (name: string, on: boolean) => {
    const enabled = on
      ? [...tools.enabled, name]
      : tools.enabled.filter((each) => each !== name);
    onChange({ ...tools, enabled });
  };

  return (
    <fieldset className="flex flex-col gap-3" data-testid="agent-tools-section">
      <legend className="mb-1 font-machine text-[10px] uppercase tracking-wider text-fg-muted">
        Tools
      </legend>

      {registry.isPending && <p className="text-xs text-fg-muted">Loading tools…</p>}
      {registry.isError && (
        <p role="alert" className="text-xs text-danger">
          Could not load tools: {registry.error.message}
        </p>
      )}

      {registry.data && registry.data.length === 0 && (
        <p className="text-xs text-fg-muted">No tools registered.</p>
      )}

      <div className="flex flex-col gap-2" role="group" aria-label="Enabled tools">
        {registry.data?.map((tool) => {
          const boxId = `tool-${tool.name}`;
          const enabled = tools.enabled.includes(tool.name);
          return (
            <div
              key={tool.name}
              data-testid={`agent-tool-${tool.name}`}
              className="flex flex-col gap-1 rounded-md border border-border bg-panel px-3 py-2"
            >
              <div className="flex items-start gap-2">
                <Checkbox
                  id={boxId}
                  checked={enabled}
                  onCheckedChange={(checked) => toggle(tool.name, checked === true)}
                />
                <div className="min-w-0 flex-1">
                  <label htmlFor={boxId} className="font-machine text-xs text-fg">
                    {tool.name}
                  </label>
                  <ToolPermissionBadges className="mt-1" permissions={tool.permissions} />
                </div>
              </div>
              {enabled && tool.permissions.destructive && (
                <p
                  data-testid={`tool-destructive-warning-${tool.name}`}
                  className="flex items-center gap-1 font-human text-[11px] text-danger"
                >
                  <TriangleAlert className="h-3 w-3 shrink-0" aria-hidden />
                  Destructive — each call waits for your approval (FR-GRD-006).
                </p>
              )}
            </div>
          );
        })}
      </div>

      {missing.length > 0 && (
        <div
          role="alert"
          data-testid="tools-not-registered"
          className="rounded-md border border-danger/60 bg-danger/10 px-3 py-2 text-xs text-danger"
        >
          <p className="font-machine">tool_not_registered</p>
          <p className="mt-0.5 font-human">
            No longer in the registry (a removed MCP server?): {missing.join(', ')}. Disable to clear
            the pre-flight error.
          </p>
        </div>
      )}

      <NumberField
        label="Max tool calls"
        value={tools.maxToolCalls}
        range={MAX_TOOL_CALLS_RANGE}
        onCommit={(maxToolCalls) => onChange({ ...tools, maxToolCalls })}
      />

      <AllowedDomainsEditor
        domains={tools.allowedDomains}
        onChange={(allowedDomains) => onChange({ ...tools, allowedDomains })}
      />
    </fieldset>
  );
}

/**
 * The allow-listed hosts an agent's network tools may reach (FR-TOOL-006). The `domain_allowlist`
 * guardrail refuses any host not here, and an empty list allows nothing — so the hint says so. A
 * host is validated before it is added and a duplicate is refused.
 */
function AllowedDomainsEditor({
  domains,
  onChange,
}: {
  domains: string[];
  onChange: (domains: string[]) => void;
}) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string>();

  const add = () => {
    const host = draft.trim();
    if (host === '') return;
    if (!isValidHost(host)) {
      setError('Enter a host such as example.com or 127.0.0.1:8080 — no scheme or path.');
      return;
    }
    if (domains.includes(host)) {
      setError('That host is already on the list.');
      return;
    }
    onChange([...domains, host]);
    setDraft('');
    setError(undefined);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      add();
    }
  };

  return (
    <Field
      label="Allowed domains"
      error={error}
      hint="Hosts network tools may reach; an empty list allows nothing (FR-TOOL-006)."
    >
      <div className="flex flex-col gap-2">
        {domains.length > 0 && (
          <ul className="flex flex-wrap gap-1.5" data-testid="allowed-domains">
            {domains.map((host) => (
              <li
                key={host}
                data-testid={`allowed-domain-${host}`}
                className="inline-flex items-center gap-1 rounded-chip border border-border bg-canvas px-2 py-0.5 font-machine text-[11px] text-fg"
              >
                {host}
                <button
                  type="button"
                  aria-label={`Remove ${host}`}
                  className="text-fg-muted hover:text-danger"
                  onClick={() => onChange(domains.filter((each) => each !== host))}
                >
                  <X className="h-3 w-3" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-center gap-2">
          <Label htmlFor="allowed-domain-input" className="sr-only">
            Add domain
          </Label>
          <Input
            id="allowed-domain-input"
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              if (error) setError(undefined);
            }}
            onKeyDown={onKeyDown}
            placeholder="example.com"
            className="font-machine"
            aria-invalid={error ? true : undefined}
          />
          <Button type="button" variant="secondary" size="sm" onClick={add}>
            Add
          </Button>
        </div>
      </div>
    </Field>
  );
}
