import type { ErrorKind } from '@ace/contracts';

/**
 * What to do next, one line per `ErrorKind` (round 3 §5 item 3, FR-ERR-002, NFR-USE-03).
 *
 * The table is exhaustive by type: `Record<ErrorKind, …>` means a ninth kind added to the contract
 * stops the build here rather than rendering a card with a blank line, and `ErrorCard.test.tsx`
 * walks `ERROR_KINDS` so the same is true at run time.
 *
 * Each line names one place to go, because that is what makes a message actionable: the screen, the
 * panel or the setting that changes the outcome — never "try again later".
 */
export const NEXT_STEP_BY_ERROR_KIND: Readonly<Record<ErrorKind, string>> = {
  user_cancelled: 'Nothing failed — you stopped this. Start the run again when you are ready.',
  agent:
    "The answer did not match the node's output contract. Loosen the contract, or say the format in the instructions, then retry.",
  provider: 'Retry, or add a fallback model on this node.',
  auth: 'Update the provider key in Providers.',
  invalid_config: 'Open the node settings and fix the setting this names.',
  network: 'Check the endpoint in Providers, and that the service is running.',
  workflow: 'An upstream node did not finish. Fix that node, then use Retry with downstream.',
  guardrail: 'See the verdicts on this node run, or adjust the policy in Guardrails.',
};

/** Human wording for the kind itself; the enum name stays the contract and is shown beside it. */
export const ERROR_KIND_LABEL: Readonly<Record<ErrorKind, string>> = {
  user_cancelled: 'you cancelled it',
  agent: 'the model broke the contract',
  provider: 'the provider failed',
  auth: 'the key was refused',
  network: 'the network failed',
  invalid_config: 'the node is misconfigured',
  workflow: 'the workflow could not get here',
  guardrail: 'a guardrail stopped it',
};
