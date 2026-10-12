import {
  PolicyInUseDetailsSchema,
  defaultGuardrailChecks,
  type GuardrailPolicy,
  type Id,
} from '@ace/contracts';
import { AceApiError } from '@ace/sdk';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from '@ace/ui';
import { useState, type FormEvent } from 'react';

import { newId } from '../lib/ulid';
import { useCreateGuardrailPolicy, useDeleteGuardrailPolicy } from './hooks';

/** What the engine put in the 409 body when agents still use the policy (§2.5, D78). */
function affectedNodeIds(error: unknown): string[] | undefined {
  if (!AceApiError.is(error) || error.code !== 'policy_in_use') return undefined;
  const details = PolicyInUseDetailsSchema.safeParse(error.details);
  return details.success ? details.data.nodeIds : [];
}

function ErrorLine({ error }: { error: Error | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="text-[12px] text-[#c94c27]">
      {error.message}
    </p>
  );
}

/**
 * A new policy (FR-GRD-001). It starts from the same fifteen checks a new project's default carries
 * — warn on content, block secret leaks and tool abuse (D10, `defaultGuardrailChecks`) — so a policy
 * is never created empty and the safe default is what a person edits away from, not towards.
 */
export function NewPolicyDialog({
  projectId,
  onClose,
  onCreated,
}: {
  projectId: Id;
  onClose: () => void;
  onCreated: (policy: GuardrailPolicy) => void;
}) {
  const create = useCreateGuardrailPolicy();
  const [name, setName] = useState('');

  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate(
      { projectId, name: name.trim(), checks: defaultGuardrailChecks(newId) },
      {
        onSuccess: (policy) => {
          onCreated(policy);
          onClose();
        },
      },
    );
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>New guardrail policy</DialogTitle>
            <DialogDescription>
              It starts at version 1 with the safe defaults: warn on content issues, block secret
              leaks and tool abuse (D10).
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-[7px]">
            <Label htmlFor="new-policy-name">Name</Label>
            <Input
              id="new-policy-name"
              value={name}
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
              placeholder="Strict"
              autoFocus
              required
            />
          </div>

          <ErrorLine error={create.error} />
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || create.isPending}>
              Create policy
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Delete a policy (§2.5). The first attempt goes without `confirm`; if the engine answers 409
 * `policy_in_use` the dialog names the agents that still point at it and only then repeats the call
 * with `confirm=true` — the same two-step the providers screen uses for `provider_in_use`.
 */
export function DeletePolicyDialog({
  policy,
  onClose,
  onDeleted,
}: {
  policy: GuardrailPolicy;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const remove = useDeleteGuardrailPolicy();
  const inUse = affectedNodeIds(remove.error);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete “{policy.name}”?</DialogTitle>
          <DialogDescription>
            Every version of it goes. Runs already recorded keep the version they used (FR-GRD-002).
          </DialogDescription>
        </DialogHeader>

        {inUse !== undefined && (
          <div
            role="alert"
            data-testid="policy-in-use"
            className="flex flex-col gap-2 rounded-[10px] border border-[var(--line)] bg-[var(--soft)] px-3 py-[10px] text-[12px]"
          >
            <p>{remove.error?.message}</p>
            {inUse.length > 0 && (
              <ul className="flex flex-col gap-1 font-machine text-[11px] text-[var(--muted)]">
                {inUse.map((nodeId) => (
                  <li key={nodeId}>{nodeId}</li>
                ))}
              </ul>
            )}
            <p className="text-[var(--muted)]">
              Deleting it anyway leaves those agents on the project default.
            </p>
          </div>
        )}
        {inUse === undefined && <ErrorLine error={remove.error} />}

        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={remove.isPending}
            onClick={() =>
              remove.mutate(
                { id: policy.id, ...(inUse === undefined ? {} : { confirm: true }) },
                {
                  onSuccess: () => {
                    onDeleted();
                    onClose();
                  },
                },
              )
            }
          >
            {inUse === undefined ? 'Delete' : 'Delete anyway'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
