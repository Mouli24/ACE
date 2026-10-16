import { providerGroup, type Provider, type Usage } from '@ace/contracts';

import { money } from './controls/HaltReason';

/**
 * PG-1.4 (D359): how a recorded cost reads. A local model is free by rule; a model with no
 * published price has an **unknown** cost (`costKnown: false`), which never reads as $0 — when a
 * total mixes known and unknown parts it shows the known part and says the rest is unknown.
 */
export const LOCAL_COST_TEXT = 'Free · runs on your machine';
export const UNKNOWN_COST_TITLE =
  'This model has no published price, so ACE cannot say what it cost. Tokens are still counted.';

type CostUsage = Pick<Usage, 'costUsd' | 'costKnown'>;

export function costText(usage: CostUsage, format: (value: number) => string = money): string {
  if (usage.costKnown !== false) return format(usage.costUsd);
  return usage.costUsd > 0 ? `${format(usage.costUsd)} + unknown` : 'unknown';
}

/** Whether this provider's models are free by rule (Local & open models, PG-1.4). */
export const isLocalProvider = (provider: Pick<Provider, 'type' | 'baseUrl'> | undefined) =>
  provider !== undefined && providerGroup(provider) === 'local';

/**
 * The cost as text with its explanation on hover. `local` says "Free · runs on your machine" in
 * place of a price.
 */
export function CostValue({
  usage,
  local = false,
  format = money,
  className,
  testId,
}: {
  usage: CostUsage;
  local?: boolean;
  format?: (value: number) => string;
  className?: string;
  testId?: string;
}) {
  const unknown = usage.costKnown === false;
  return (
    <span
      className={className}
      data-testid={testId}
      data-cost-known={unknown ? 'false' : 'true'}
      title={unknown ? UNKNOWN_COST_TITLE : local ? 'Local models cost nothing to run' : undefined}
    >
      {local && !unknown && usage.costUsd === 0 ? LOCAL_COST_TEXT : costText(usage, format)}
    </span>
  );
}
