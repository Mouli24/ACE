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
} from '@ace/ui';
import { Plus, ShieldCheck } from 'lucide-react';
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
    <main className="mx-auto flex h-full w-full max-w-5xl flex-col gap-6 overflow-y-auto px-4 py-10">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-human text-2xl font-semibold">Guardrail policies</h1>
        <Button disabled={!projectId} onClick={() => setDialog({ kind: 'new' })}>
          <Plus className="h-4 w-4" /> New policy
        </Button>
      </header>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="guardrails-project">Project</Label>
        <Select
          value={projectId ?? ''}
          onValueChange={pickProject}
          disabled={!projects.data?.length}
        >
          <SelectTrigger id="guardrails-project" className="w-72" aria-label="Project">
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
        <p className="rounded-card border border-dashed border-border p-8 text-center text-fg-muted">
          No projects yet. A policy belongs to a project, so create one first.
        </p>
      )}

      {policies.isPending && projectId && <p className="text-fg-muted">Loading policies…</p>}
      {policies.isError && (
        <p role="alert" className="text-danger">
          Could not load policies: {policies.error.message}
        </p>
      )}

      {items.length > 0 && (
        <ul data-testid="policy-list" className="flex flex-col gap-2">
          {items.map((policy) => (
            <li
              key={policy.id}
              data-testid={`policy-row-${policy.id}`}
              aria-current={policy.id === selected?.id}
              className={`flex flex-wrap items-center gap-3 rounded-card border bg-panel px-4 py-3 ${
                policy.id === selected?.id ? 'border-accent' : 'border-border'
              }`}
            >
              <button
                type="button"
                className="min-w-0 flex-1 text-left"
                onClick={() => setChosenPolicyId(policy.id)}
              >
                <span
                  className="truncate font-human text-base"
                  data-testid={`policy-name-${policy.id}`}
                >
                  {policy.name}
                </span>
                <span
                  className="ml-2 font-machine text-xs text-fg-muted"
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
                variant="ghost"
                size="sm"
                className="text-danger"
                onClick={() => setDialog({ kind: 'delete', policy })}
              >
                Delete
              </Button>
            </li>
          ))}
        </ul>
      )}

      {setDefault.error && (
        <p role="alert" className="text-sm text-danger">
          {setDefault.error.message}
        </p>
      )}

      {selected && (
        <div className="flex flex-col gap-6">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-fg-muted" aria-hidden />
            <h2 className="font-human text-lg font-semibold" data-testid="selected-policy-heading">
              {selected.name} · version {selected.version}
            </h2>
          </div>
          <PolicyEditor key={selected.id} policy={selected} />
          <PolicyTestPanel key={`${selected.id}-test`} policy={selected} />
        </div>
      )}

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
