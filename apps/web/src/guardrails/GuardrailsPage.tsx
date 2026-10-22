import type { GuardrailPolicy } from '@ace/contracts';
import {
  Badge,
  Button,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  cn,
} from '@ace/ui';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { useProjects } from '../projects/hooks';
import { PolicyEditor } from './PolicyEditor';
import { DeletePolicyDialog, NewPolicyDialog } from './PolicyDialogs';
import { PolicyTestPanel } from './PolicyTestPanel';
import { useGuardrailPolicies, useSetDefaultGuardrailPolicy } from './hooks';

/**
 * `/guardrails` (Arch §33.2, §33.3 — "Guardrail policies"): the policies of one project, the editor
 * for the one selected, and a panel that tries it on a piece of text (FR-GRD-001, 011, 014, 018).
 *
 * Policies belong to a project (§2.2) while the route does not name one, so the project is a picker
 * whose value is kept in `?projectId=` — a policy screen stays linkable, and the list below is
 * always the list of one project. A new project already has its default policy, created with it
 * (FR-GRD-018), so the list is never empty for a real project.
 *
 * An uncovered screen in the Ace UI theme (D328): the policies are selectable cards like the
 * theme's connection-type cards (1.5px border, ink when chosen).
 */
export function GuardrailsPage() {
  const projects = useProjects();
  const [params, setParams] = useSearchParams();
  const [dialog, setDialog] = useState<
    { kind: 'new' } | { kind: 'delete'; policy: GuardrailPolicy }
  >();
  const [chosenPolicyId, setChosenPolicyId] = useState<string>();

  const projectId = params.get('projectId') ?? projects.data?.[0]?.id;
  const policies = useGuardrailPolicies(projectId);
  const setDefault = useSetDefaultGuardrailPolicy();

  const items = policies.data ?? [];
  const selected =
    items.find((policy) => policy.id === chosenPolicyId) ??
    items.find((policy) => policy.isProjectDefault) ??
    items[0];

  const pickProject = (next: string) => {
    setParams((current) => {
      const updated = new URLSearchParams(current);
      updated.set('projectId', next);
      return updated;
    });
    setChosenPolicyId(undefined);
  };

  return (
    <main className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[960px] flex-col gap-6 px-6 py-8">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-[20px] font-bold tracking-[-0.01em]">Guardrail policies</h1>
          <Button disabled={!projectId} onClick={() => setDialog({ kind: 'new' })}>
            New policy
          </Button>
        </header>

        <div className="flex w-full max-w-[320px] flex-col gap-[7px]">
          <Label htmlFor="guardrails-project">Project</Label>
          <Select
            value={projectId ?? ''}
            onValueChange={pickProject}
            disabled={!projects.data?.length}
          >
            <SelectTrigger id="guardrails-project" aria-label="Project">
              <SelectValue placeholder="No projects yet" />
            </SelectTrigger>
            <SelectContent>
              {(projects.data ?? []).map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  {project.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {projects.data?.length === 0 && (
          <p className="py-10 text-center text-[13px] text-[var(--muted)]">
            No projects yet. A policy belongs to a project, so create one first.
          </p>
        )}

        {policies.isPending && projectId && (
          <p className="text-[13px] text-[var(--muted)]">Loading policies…</p>
        )}
        {policies.isError && (
          <p role="alert" className="text-[12px] text-danger">
            Could not load policies: {policies.error.message}
          </p>
        )}

        {items.length > 0 && (
          <ul data-testid="policy-list" className="flex flex-col gap-2">
            {items.map((policy) => {
              const current = policy.id === selected?.id;
              return (
                <li
                  key={policy.id}
                  data-testid={`policy-row-${policy.id}`}
                  aria-current={current}
                  className={cn(
                    'flex flex-wrap items-center gap-3 rounded-[10px] border-[1.5px] bg-[var(--surface)] p-3',
                    current ? 'border-[var(--ink)]' : 'border-[var(--line)]',
                  )}
                >
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-[10px] rounded-[7px] text-left outline-none focus-visible:shadow-[0_0_0_2px_var(--focus)]"
                    onClick={() => setChosenPolicyId(policy.id)}
                  >
                    {/* The theme's radio dot: a 15px ring, a 7px ink dot when chosen. */}
                    <span
                      aria-hidden
                      className={cn(
                        'flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-full border-[1.5px]',
                        current ? 'border-[var(--ink)]' : 'border-[var(--line)]',
                      )}
                    >
                      <span
                        className={cn(
                          'h-[7px] w-[7px] rounded-full',
                          current ? 'bg-[var(--ink)]' : 'bg-transparent',
                        )}
                      />
                    </span>
                    <span
                      className="truncate text-[13.5px] font-bold"
                      data-testid={`policy-name-${policy.id}`}
                    >
                      {policy.name}
                    </span>
                    <span
                      className="shrink-0 font-machine text-[10px] text-[var(--muted)]"
                      data-testid={`policy-version-${policy.id}`}
                    >
                      version {policy.version}
                    </span>
                  </button>

                  {/* FR-GRD-018: which policy a run uses when a node names none. */}
                  {policy.isProjectDefault ? (
                    <Badge variant="accent" data-testid={`policy-default-${policy.id}`}>
                      default
                    </Badge>
                  ) : (
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={setDefault.isPending}
                      onClick={() => setDefault.mutate(policy.id)}
                    >
                      Set as project default
                    </Button>
                  )}

                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => setDialog({ kind: 'delete', policy })}
                  >
                    Delete
                  </Button>
                </li>
              );
            })}
          </ul>
        )}

        {setDefault.error && (
          <p role="alert" className="text-[12px] text-danger">
            {setDefault.error.message}
          </p>
        )}

        {selected && (
          <div className="flex flex-col gap-4">
            <h2
              className="text-[16px] font-semibold tracking-[-0.01em]"
              data-testid="selected-policy-heading"
            >
              {selected.name} · version {selected.version}
            </h2>
            <PolicyEditor key={selected.id} policy={selected} />
            <PolicyTestPanel key={`${selected.id}-test`} policy={selected} />
          </div>
        )}
      </div>

      {dialog?.kind === 'new' && projectId && (
        <NewPolicyDialog
          projectId={projectId}
          onClose={() => setDialog(undefined)}
          onCreated={(policy) => setChosenPolicyId(policy.id)}
        />
      )}
      {dialog?.kind === 'delete' && (
        <DeletePolicyDialog
          policy={dialog.policy}
          onClose={() => setDialog(undefined)}
          onDeleted={() => setChosenPolicyId(undefined)}
        />
      )}
    </main>
  );
}
