import type { Id } from '@ace/contracts';

import { SelectField } from '../config-panel/fields';
import { useGuardrailPolicies } from './hooks';

/** The value that means "no override" — the project default decides (FR-GRD-002, D10). */
export const PROJECT_DEFAULT = 'project-default';

/**
 * An Agent node's guardrail policy (FR-GRD-002, TC-GRD-002): the project default, or one named
 * policy that overrides it for this node alone.
 *
 * The list is the project's, and the default is whichever policy the engine flagged — never a guess
 * here (BR-01, FR-GRD-018). Choosing the default clears `guardrailPolicyId` rather than writing the
 * default's id into the node, so the node keeps following the project when the default moves.
 */
export function PolicyPicker({
  projectId,
  value,
  onChange,
  disabled,
}: {
  projectId: Id | undefined;
  /** `AgentConfig.guardrailPolicyId`; absent means the project default. */
  value: Id | undefined;
  onChange: (policyId: Id | undefined) => void;
  disabled?: boolean;
}) {
  const policies = useGuardrailPolicies(projectId);
  const items = policies.data ?? [];
  const projectDefault = items.find((policy) => policy.isProjectDefault);

  const options = [
    {
      value: PROJECT_DEFAULT,
      label:
        projectDefault === undefined
          ? 'project default'
          : `project default (${projectDefault.name})`,
    },
    ...items.map((policy) => ({
      value: policy.id,
      label: `${policy.name} · version ${policy.version}`,
    })),
  ];

  /*
   * A node may name a policy that has since been deleted. The id is kept — the engine owns the node,
   * and a picker must not quietly rewrite it — and the missing policy is offered as its own option so
   * the box is never blank and the state is visible.
   */
  const missing = value !== undefined && !items.some((policy) => policy.id === value);
  if (missing) options.push({ value, label: `${value.slice(-6)} · no longer exists` });

  return (
    <SelectField
      label="Guardrail policy"
      value={value ?? PROJECT_DEFAULT}
      options={options}
      onChange={(next) => onChange(next === PROJECT_DEFAULT ? undefined : next)}
      hint={
        missing
          ? 'This policy has been deleted; choose another or fall back to the project default.'
          : 'An override applies to this node only; the project default applies to the rest.'
      }
      {...(disabled === undefined ? {} : { disabled })}
    />
  );
}
