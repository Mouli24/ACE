import type { AgentConfig, ToolPermissions } from '@ace/contracts';
import { Button, Checkbox, FIELD_LABEL_CLASS, Icons, Input } from '@ace/ui';
import { useMemo, useState, type KeyboardEvent } from 'react';

import { useTools } from '../library/tools-hooks';
import { ERROR_CLASS, Field, HELP_CLASS, NumberField } from './fields';
import type { NumberRange } from './validation';

/**
 * The Agent node's "Tools" config section (round 4 §5 item 6, FR-TOOL-002/006). Which tools the
 * agent may call is a set of names it keeps in `AgentConfig.tools.enabled`; the call limit and the
 * allow-listed domains live beside it. The registry (`GET /tools`) decides what can be enabled — a
 * name still in `enabled` that the registry no longer offers is shown as `tool_not_registered`, the
 * same code pre-flight raises for it (validation.ts), so a removed MCP server's tool is visible
 * rather than silent.
 *
 * In the node settings modal the tools a skill groups are toggled by the skill (D333), so they are
 * left out of this list (`exclude`). Every edit patches the whole `tools` object at once, the way
 * the other Agent fields patch theirs.
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

/** The theme's mono chip (8.5px, 0.08em), neutral or in the destructive ink. */
const CHIP_CLASS =
  'shrink-0 rounded-[4px] px-1.5 py-0.5 font-machine text-[8.5px] font-medium uppercase tracking-[0.08em]';

/** What a tool may touch, as the three facts the registry states (FR-TOOL-001). */
function PermissionChips({ permissions }: { permissions: ToolPermissions }) {
  const { network, fsPaths, destructive } = permissions;
  return (
    <span className="flex flex-wrap items-center gap-1" data-testid="tool-permission-badges">
      {network && (
        <span className={`${CHIP_CLASS} bg-[var(--hover)] text-[var(--muted)]`}>network</span>
      )}
      {fsPaths.map((path) => (
        <span key={path} className={`${CHIP_CLASS} bg-[var(--hover)] text-[var(--muted)]`}>
          {path}
        </span>
      ))}
      {destructive && (
        <span className={`${CHIP_CLASS} bg-[#c94c271f] text-[#c94c27]`}>destructive</span>
      )}
    </span>
  );
}

export function AgentToolsSection({
  tools,
  onChange,
  exclude = [],
  hideMaxToolCalls = false,
}: {
  tools: ToolsConfig;
  onChange: (tools: ToolsConfig) => void;
  /** Registry tools not listed here because something else toggles them (the modal's skills). */
  exclude?: readonly string[];
  /** Workspace access replaces the call cap with Max turns (D342). */
  hideMaxToolCalls?: boolean;
}) {
  const registry = useTools();

  const registryNames = useMemo(
    () => new Set((registry.data ?? []).map((tool) => tool.name)),
    [registry.data],
  );
  /** Enabled names the registry no longer offers (FR-TOOL-002, `tool_not_registered`). */
  const missing = tools.enabled.filter((name) => !registryNames.has(name));
  const listed = (registry.data ?? []).filter((tool) => !exclude.includes(tool.name));

  const toggle = (name: string, on: boolean) => {
    const enabled = on ? [...tools.enabled, name] : tools.enabled.filter((each) => each !== name);
    onChange({ ...tools, enabled });
  };

  return (
    <fieldset className="flex min-w-0 flex-col gap-5" data-testid="agent-tools-section">
      <legend className="sr-only">Tools</legend>

      <div className="flex flex-col gap-[7px]">
        <span aria-hidden className={FIELD_LABEL_CLASS}>
          {exclude.length > 0 ? 'Other tools' : 'Tools'}
        </span>

        {registry.isPending && <p className={HELP_CLASS}>Loading tools…</p>}
        {registry.isError && (
          <p role="alert" className={ERROR_CLASS}>
            Could not load tools: {registry.error.message}
          </p>
        )}
        {registry.data && registry.data.length === 0 && (
          <p className={HELP_CLASS}>No tools registered.</p>
        )}

        <div
          className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-2"
          role="group"
          aria-label="Enabled tools"
        >
          {listed.map((tool) => {
            const boxId = `tool-${tool.name}`;
            const enabled = tools.enabled.includes(tool.name);
            return (
              <div
                key={tool.name}
                data-testid={`agent-tool-${tool.name}`}
                className="flex min-w-0 flex-col gap-1.5 rounded-[9px] border border-[var(--line)] px-3 py-2.5"
              >
                <div className="flex items-center gap-2">
                  <Checkbox
                    id={boxId}
                    checked={enabled}
                    onCheckedChange={(checked) => toggle(tool.name, checked === true)}
                  />
                  <label
                    htmlFor={boxId}
                    className="min-w-0 flex-1 cursor-pointer truncate font-machine text-[12px] text-[var(--ink)]"
                  >
                    {tool.name}
                  </label>
                </div>
                <PermissionChips permissions={tool.permissions} />
                {enabled && tool.permissions.destructive && (
                  <p data-testid={`tool-destructive-warning-${tool.name}`} className={ERROR_CLASS}>
                    Destructive — each call waits for your approval (FR-GRD-006).
                  </p>
                )}
              </div>
            );
          })}
        </div>

        {missing.length > 0 && (
          <div role="alert" data-testid="tools-not-registered" className={ERROR_CLASS}>
            <p className="font-machine">tool_not_registered</p>
            <p>
              No longer in the registry (a removed MCP server?): {missing.join(', ')}. Disable to
              clear the pre-flight error.
            </p>
          </div>
        )}
      </div>

      {!hideMaxToolCalls && (
        <NumberField
          label="Max tool calls"
          value={tools.maxToolCalls}
          range={MAX_TOOL_CALLS_RANGE}
          onCommit={(maxToolCalls) => onChange({ ...tools, maxToolCalls })}
        />
      )}

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
      htmlFor="allowed-domain-input"
      {...(error === undefined
        ? { hint: 'Hosts network tools may reach; an empty list allows nothing (FR-TOOL-006).' }
        : { error })}
    >
      {domains.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" data-testid="allowed-domains">
          {domains.map((host) => (
            <li
              key={host}
              data-testid={`allowed-domain-${host}`}
              className="inline-flex items-center gap-1.5 rounded-[4px] bg-[var(--hover)] py-0.5 pl-1.5 pr-1 font-machine text-[11px] text-[var(--ink)]"
            >
              {host}
              <button
                type="button"
                aria-label={`Remove ${host}`}
                className="cursor-pointer border-none bg-transparent p-0 text-[10px] text-[var(--muted)] outline-none hover:text-[#c94c27] focus-visible:text-[#c94c27]"
                onClick={() => onChange(domains.filter((each) => each !== host))}
              >
                <Icons.X aria-hidden size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-2">
        <Input
          id="allowed-domain-input"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            if (error) setError(undefined);
          }}
          onKeyDown={onKeyDown}
          placeholder="example.com"
          spellCheck={false}
          className="font-machine text-[12px]"
          aria-invalid={error ? true : undefined}
        />
        <Button type="button" variant="secondary" size="lg" onClick={add}>
          Add
        </Button>
      </div>
    </Field>
  );
}
