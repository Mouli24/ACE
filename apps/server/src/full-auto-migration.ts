import type { Id, Message, Provider } from '@ace/contracts';
import { newId, type EventBus, type Logger, type Repository, type Scope } from '@ace/engine';

/**
 * D355 (PG-2.3): no CLI provider stays on Full auto. D262's `full_auto` preset bypassed every ACE
 * approval, budget and guardrail (Claude Code's `bypassPermissions`, Codex's
 * `--dangerously-bypass-approvals-and-sandbox`, Gemini's `yolo`). The contract keeps the value only
 * so an old row parses; at startup every provider still on it is moved to `edit_files`.
 *
 * A data migration, not a Drizzle one: the column and its values are unchanged, and a Drizzle
 * migration on `main` is never edited (CLAUDE.md §3.4). It runs on every start and does nothing
 * once no row is on `full_auto`, so it is safe to run again.
 *
 * The notice, once, through the engine's existing notice channel: a `system` message in the
 * Timeline of each workflow whose nodes use the provider — where provider status changes are
 * already announced — plus a warning in the engine log, which is where it lands when no workflow
 * uses the provider yet.
 */
export interface FullAutoMigrationDeps {
  repository: Repository;
  scope: Scope;
  bus: EventBus;
  logger: Logger;
  now?: () => string;
}

/** What the person is told, naming the provider as they named it. */
export function fullAutoNotice(name: string): string {
  return (
    `Provider ${name} was on Full auto, which is no longer offered: it ran the CLI without ` +
    'ACE’s approvals, budgets or guardrails. It now uses Edit project files.'
  );
}

/** Moves every `full_auto` provider to `edit_files`; returns the providers it moved. */
export async function migrateFullAutoProviders(deps: FullAutoMigrationDeps): Promise<Provider[]> {
  const { repository, scope, bus, logger } = deps;
  const now = deps.now ?? ((): string => new Date().toISOString());
  const moved: Provider[] = [];

  for (const provider of await repository.providers.list(scope)) {
    if (provider.cliPermission !== 'full_auto') continue;
    const updated = await repository.providers.update(scope, provider.id, {
      cliPermission: 'edit_files',
      updatedAt: now(),
    });
    if (updated === null) continue;
    moved.push(updated);

    const notice = fullAutoNotice(provider.name);
    logger.warn(
      { subsystem: 'providers', providerId: provider.id, decision: 'D355' },
      notice,
    );

    const nodes = await repository.nodes.listByProvider(scope, provider.id);
    const workflowIds: Id[] = [...new Set(nodes.map((node) => node.workflowId))].sort();
    for (const workflowId of workflowIds) {
      const message: Message = {
        id: newId(),
        workflowId,
        type: 'system',
        content: [{ type: 'text', text: notice }],
        at: now(),
      };
      await repository.messages.append(scope, message);
      await bus.emit({ type: 'message.created', workflowId, payload: { workflowId, message } });
    }
  }

  return moved;
}
