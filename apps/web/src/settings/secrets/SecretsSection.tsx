import type { Project, Secret } from '@ace/contracts';
import { Button, toast } from '@ace/ui';
import { KeyRound, Plus } from 'lucide-react';
import { useState } from 'react';

import { ConfirmDialog } from '../../knowledge/ConfirmDialog';
import { useProjects } from '../../projects/hooks';
import { timeAgo } from '../../tasks/meta';
import { useDeleteSecret, useSecrets } from './hooks';
import { AddSecretDialog, ReplaceSecretDialog } from './SecretDialogs';

/** "All projects", or the names of the projects it is limited to. */
export function secretScopeLabel(secret: Secret, projects: readonly Project[]): string {
  if (secret.projectIds.length === 0) return 'All projects';
  return secret.projectIds
    .map((id) => projects.find((project) => project.id === id)?.name ?? 'a deleted project')
    .join(', ');
}

type Open =
  | { kind: 'add' }
  | { kind: 'replace'; secret: Secret }
  | { kind: 'delete'; secret: Secret }
  | undefined;

/**
 * Settings › Secrets (ACE parity P1, D274): named environment variables for check and setup
 * commands and coding-agent CLIs. The list shows each secret's name, description, scope and when it
 * last changed — never a value; a value is typed into a password field, sent once, and kept only in
 * the OS keychain.
 */
export function SecretsSection() {
  const secrets = useSecrets();
  const projects = useProjects();
  const remove = useDeleteSecret();
  const [open, setOpen] = useState<Open>();
  const list = secrets.data ?? [];
  const projectList = projects.data ?? [];
  const close = () => setOpen(undefined);

  return (
    <section className="flex flex-col gap-4" data-testid="settings-secrets">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-human text-sm font-semibold">Secrets</h2>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setOpen({ kind: 'add' })}
          disabled={secrets.isLoading}
        >
          <Plus className="h-3.5 w-3.5" aria-hidden />
          Add secret
        </Button>
      </div>
      <p className="text-xs text-fg-muted" data-testid="secrets-note">
        Secrets are environment variables for a project’s check and setup commands and for
        coding-agent CLIs. Values live in your operating system’s keychain, never in ACE’s database;
        agents see only the names, and values are scrubbed from logs and stored output.
      </p>

      {secrets.isError ? (
        <p role="alert" className="text-xs text-danger">
          The secrets could not be loaded.
        </p>
      ) : list.length === 0 ? (
        <p className="text-xs text-fg-muted" data-testid="secrets-empty">
          {secrets.isLoading ? 'Loading…' : 'No secrets yet.'}
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-card border border-border bg-panel">
          {list.map((secret) => (
            <li
              key={secret.name}
              data-testid={`secret-${secret.name}`}
              className="flex flex-wrap items-start gap-x-3 gap-y-2 p-3"
            >
              <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-fg-muted" aria-hidden />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="break-all font-machine text-sm">{secret.name}</span>
                {secret.description !== '' && (
                  <span className="text-xs text-fg-soft">{secret.description}</span>
                )}
                <span className="text-xs text-fg-muted">
                  <span data-testid="secret-scope-label">
                    {secretScopeLabel(secret, projectList)}
                  </span>
                  {' · updated '}
                  <time
                    dateTime={secret.updatedAt}
                    title={new Date(secret.updatedAt).toLocaleString()}
                  >
                    {timeAgo(secret.updatedAt)}
                  </time>
                </span>
              </div>
              <div className="flex shrink-0 gap-1.5">
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Replace the value of ${secret.name}`}
                  onClick={() => setOpen({ kind: 'replace', secret })}
                >
                  Replace value
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-danger"
                  aria-label={`Delete ${secret.name}`}
                  onClick={() => setOpen({ kind: 'delete', secret })}
                >
                  Delete
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {open?.kind === 'add' && (
        <AddSecretDialog
          projects={projectList}
          taken={list.map((secret) => secret.name)}
          onClose={close}
        />
      )}
      {open?.kind === 'replace' && <ReplaceSecretDialog secret={open.secret} onClose={close} />}
      {open?.kind === 'delete' && (
        <ConfirmDialog
          title={`Delete ${open.secret.name}?`}
          description="Its value is removed from your keychain. Commands and agents that read it will no longer get it."
          confirmLabel="Delete secret"
          pending={remove.isPending}
          error={remove.error}
          onClose={close}
          onConfirm={() =>
            remove.mutate(open.secret.name, {
              onSuccess: () => {
                toast.success(`Secret ${open.secret.name} deleted`);
                close();
              },
            })
          }
        />
      )}
    </section>
  );
}
