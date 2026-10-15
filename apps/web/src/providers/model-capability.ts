import {
  capabilityGaps,
  isCliProviderType,
  type CapabilityGap,
  type CapabilityNeeds,
  type Model,
  type Provider,
} from '@ace/contracts';

/** A capability gap in the few words a model list has room for; the full reason is its title. */
export function shortCapabilityReason(gap: CapabilityGap, cli: boolean): string {
  if (gap.code === 'tools_unsupported') return 'cannot call tools';
  return cli ? 'a CLI cannot follow a JSON schema' : 'no structured JSON output';
}

/**
 * D353 (PG-2.1): why a model would be blocked at pre-flight for what this node asks of it — its
 * output contract's schema, its tools or skills. The same rule as the engine's `schema_unsupported`
 * and `tools_unsupported` (`capabilityGaps`), so the picker says now what the run would say later.
 */
export function modelCapabilityBlock(
  model: Model,
  needs: CapabilityNeeds | undefined,
  provider: Pick<Provider, 'type'> | undefined,
): { short: string; reason: string } | undefined {
  if (needs === undefined || !model.available) return undefined;
  const cli = provider !== undefined && isCliProviderType(provider.type);
  const gaps = capabilityGaps(needs, model, cli);
  if (gaps.length === 0) return undefined;
  return {
    short: gaps.map((gap) => shortCapabilityReason(gap, cli)).join('; '),
    reason: gaps.map((gap) => gap.reason).join(' '),
  };
}
