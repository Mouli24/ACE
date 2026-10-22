import {
  DEFAULT_CLI_PERMISSION,
  agentToolNames,
  isCliProviderType,
  type Node,
  type Provider,
} from '@ace/contracts';

/**
 * PG-2.4 (D361): what counts as a *writing* run or chat turn — one whose checkpoint must begin
 * before it may change the project, or which stops and asks "Run without undo / Cancel".
 *
 * A node writes when it can change the project folder: an agent with a project-writing tool
 * enabled — or, with workspace access, granted by its access level (D375: `agentToolNames`, which
 * is `tools.enabled` unchanged for an Off node) — or a node on a coding-agent CLI whose permission
 * preset lets it edit. A node with no
 * such tool and an API or local model only reads, so a checkpoint that cannot begin is logged and
 * the run goes on (D300's original rule, kept for it).
 */

/** The built-in tools that change files in the project folder (`run_command` can, too). */
export const PROJECT_WRITING_TOOLS: readonly string[] = ['write_file', 'edit_file', 'run_command'];

/** The words a run or turn stops with when its checkpoint cannot begin (D361). */
export const UNDO_UNAVAILABLE_TITLE = "Can't record changes for undo";

export function undoUnavailableMessage(reason: string, what: 'run' | 'turn'): string {
  const subject = what === 'run' ? 'This run' : 'This turn';
  return (
    `${UNDO_UNAVAILABLE_TITLE}: ${reason.trim() || 'the checkpoint could not begin'}. ` +
    `${subject} stopped before changing any file. Choose Run without undo to go ahead once ` +
    'without a checkpoint, or Cancel.'
  );
}

/** Does this node, as configured, write to the project folder? */
export function nodeWrites(
  node: Node,
  providerOf: (providerId: string) => Pick<Provider, 'type' | 'cliPermission'> | undefined,
): boolean {
  if (node.kind !== 'agent' && node.kind !== 'model') return false;
  if (
    node.kind === 'agent' &&
    agentToolNames(node.config).some((name) => PROJECT_WRITING_TOOLS.includes(name))
  ) {
    return true;
  }
  const providerId = node.config.providerId;
  if (providerId === undefined) return false;
  const provider = providerOf(providerId);
  if (provider === undefined || !isCliProviderType(provider.type)) return false;
  return (provider.cliPermission ?? DEFAULT_CLI_PERMISSION) !== 'read_only';
}
