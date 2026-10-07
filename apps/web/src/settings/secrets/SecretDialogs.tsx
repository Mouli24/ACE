import {
  CreateSecretRequestSchema,
  RESERVED_SECRET_NAMES,
  SECRET_DESCRIPTION_MAX,
  SECRET_NAME_REGEX,
  SECRET_VALUE_MAX,
  UpdateSecretRequestSchema,
  type Project,
  type Secret,
} from '@ace/contracts';
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  toast,
} from '@ace/ui';
import { AceApiError } from '@ace/sdk';
import { useState, type FormEvent } from 'react';

import { FieldError } from '../../knowledge/fields';
import { useCreateSecret, useUpdateSecret } from './hooks';

/** Below this length a value is not scrubbed from logs (the engine's `SCRUB_MIN_LENGTH`, D274). */
const SCRUB_MIN_LENGTH = 4;

/**
 * What is wrong with a name as it is typed, or `undefined` when it is fine — checked against the
 * contract's own rules (`SECRET_NAME_REGEX`, `RESERVED_SECRET_NAMES`) and the names already taken.
 */
export function secretNameProblem(name: string, taken: readonly string[]): string | undefined {
  if (name === '') return undefined;
  if (!SECRET_NAME_REGEX.test(name)) {
    return /^[A-Za-z][A-Za-z0-9_]*$/.test(name) && name.length <= 64
      ? `Use capitals: ${name.toUpperCase()}.`
      : 'Use UPPER_SNAKE_CASE: a capital letter first, then capitals, digits or underscores (at most 64).';
  }
  if ((RESERVED_SECRET_NAMES as readonly string[]).includes(name)) {
    return `${name} is reserved: the shell or ACE itself relies on it.`;
  }
  if (taken.includes(name)) return `A secret named ${name} already exists.`;
  return undefined;
}

const shortValueHint = (value: string): string | undefined =>
  value !== '' && value.length < SCRUB_MIN_LENGTH
    ? `Shorter than ${SCRUB_MIN_LENGTH} characters, so it will not be scrubbed from logs.`
    : undefined;

/** "Which projects get it": none ticked is every project. */
function ProjectScope({
  projects,
  selected,
  onChange,
}: {
  projects: readonly Project[];
  selected: readonly string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-1.5" data-testid="secret-scope">
      <legend className="mb-1.5 text-sm font-medium">Projects</legend>
      <p className="text-xs text-fg-muted">
        {selected.length === 0
          ? 'All projects — tick projects to limit it to them.'
          : `Only the ${selected.length === 1 ? 'project' : `${selected.length} projects`} ticked.`}
      </p>
      {projects.length === 0 ? (
        <p className="text-xs text-fg-muted">No projects yet.</p>
      ) : (
        <ul className="flex max-h-40 flex-col gap-1.5 overflow-y-auto">
          {projects.map((project) => {
            const id = `secret-scope-${project.id}`;
            return (
              <li key={project.id} className="flex items-center gap-2">
                <Checkbox
                  id={id}
                  checked={selected.includes(project.id)}
                  onCheckedChange={(checked) =>
                    onChange(
                      checked === true
                        ? [...selected, project.id]
                        : selected.filter((each) => each !== project.id),
                    )
                  }
                />
                <Label htmlFor={id} className="font-normal">
                  {project.name}
                </Label>
              </li>
            );
          })}
        </ul>
      )}
    </fieldset>
  );
}

function refusal(error: unknown): string {
  if (AceApiError.is(error)) return error.message;
  return error instanceof Error ? error.message : 'The engine refused it.';
}

/**
 * Add secret (D274): a name, its value (a password field — never shown, never kept here after the
 * dialog closes), an optional description and the projects that get it.
 */
export function AddSecretDialog({
  projects,
  taken,
  onClose,
}: {
  projects: readonly Project[];
  taken: readonly string[];
  onClose: () => void;
}) {
  const create = useCreateSecret();
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [description, setDescription] = useState('');
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [submitted, setSubmitted] = useState(false);

  const nameProblem =
    secretNameProblem(name, taken) ?? (submitted && name === '' ? 'Name it.' : undefined);
  const valueProblem = submitted && value === '' ? 'Enter the value.' : undefined;

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    const parsed = CreateSecretRequestSchema.safeParse({
      name,
      value,
      ...(description.trim() === '' ? {} : { description: description.trim() }),
      ...(projectIds.length === 0 ? {} : { projectIds }),
    });
    if (!parsed.success || secretNameProblem(name, taken) !== undefined) return;
    create.mutate(parsed.data, {
      onSuccess: (secret) => {
        toast.success(`Secret ${secret.name} added`);
        onClose();
      },
    });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-[calc(100vw-2rem)] overflow-y-auto sm:max-w-md">
        <form
          onSubmit={onSubmit}
          noValidate
          className="flex flex-col gap-4"
          data-testid="add-secret"
        >
          <DialogHeader>
            <DialogTitle>Add secret</DialogTitle>
            <DialogDescription>
              An environment variable for check and setup commands and coding-agent CLIs. The value
              goes to your OS keychain; agents see only the name.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="secret-name">Name</Label>
            <Input
              id="secret-name"
              value={name}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              placeholder="DEPLOY_TOKEN"
              className="font-machine"
              aria-invalid={nameProblem ? true : undefined}
              aria-describedby={nameProblem ? 'secret-name-error' : undefined}
              onChange={(event) => setName(event.target.value.trim())}
            />
            <FieldError id="secret-name-error" message={nameProblem} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="secret-value">Value</Label>
            <Input
              id="secret-value"
              type="password"
              value={value}
              maxLength={SECRET_VALUE_MAX}
              autoComplete="new-password"
              spellCheck={false}
              aria-invalid={valueProblem ? true : undefined}
              aria-describedby={valueProblem ? 'secret-value-error' : 'secret-value-hint'}
              onChange={(event) => setValue(event.target.value)}
            />
            <FieldError id="secret-value-error" message={valueProblem} />
            {shortValueHint(value) && (
              <p id="secret-value-hint" className="text-xs text-fg-muted">
                {shortValueHint(value)}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="secret-description">Description</Label>
            <Input
              id="secret-description"
              value={description}
              maxLength={SECRET_DESCRIPTION_MAX}
              placeholder="What it is for (optional)"
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>

          <ProjectScope projects={projects} selected={projectIds} onChange={setProjectIds} />

          {create.error && (
            <p role="alert" className="text-sm text-danger">
              {refusal(create.error)}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending}>
              Add secret
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Replace value (D274): a new value for an existing secret; the old one is never shown. */
export function ReplaceSecretDialog({ secret, onClose }: { secret: Secret; onClose: () => void }) {
  const update = useUpdateSecret();
  const [value, setValue] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const problem = submitted && value === '' ? 'Enter the new value.' : undefined;

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    const parsed = UpdateSecretRequestSchema.safeParse({ value });
    if (!parsed.success || value === '') return;
    update.mutate(
      { name: secret.name, ...parsed.data },
      {
        onSuccess: () => {
          toast.success(`Secret ${secret.name} replaced`);
          onClose();
        },
      },
    );
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md">
        <form
          onSubmit={onSubmit}
          noValidate
          className="flex flex-col gap-4"
          data-testid="replace-secret"
        >
          <DialogHeader>
            <DialogTitle>
              Replace <span className="font-machine">{secret.name}</span>
            </DialogTitle>
            <DialogDescription>
              The new value replaces the one in your keychain. Runs and checks that start from now
              on get it.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="secret-new-value">New value</Label>
            <Input
              id="secret-new-value"
              type="password"
              value={value}
              autoFocus
              maxLength={SECRET_VALUE_MAX}
              autoComplete="new-password"
              spellCheck={false}
              aria-invalid={problem ? true : undefined}
              aria-describedby={problem ? 'secret-new-value-error' : undefined}
              onChange={(event) => setValue(event.target.value)}
            />
            <FieldError id="secret-new-value-error" message={problem} />
            {shortValueHint(value) && (
              <p className="text-xs text-fg-muted">{shortValueHint(value)}</p>
            )}
          </div>
          {update.error && (
            <p role="alert" className="text-sm text-danger">
              {refusal(update.error)}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={update.isPending}>
              Replace value
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
