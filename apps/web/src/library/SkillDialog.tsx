import {
  SKILL_DESCRIPTION_MAX,
  SKILL_INSTRUCTIONS_MAX,
  SKILL_NAME_MAX,
  type Skill,
} from '@ace/contracts';
import { AceApiError } from '@ace/sdk';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Textarea,
  toast,
} from '@ace/ui';
import { Copy } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';

import { useCreateSkill, useDuplicateSkill, useUpdateSkill } from './skills-hooks';

/** What a source means, in words a person choosing a skill reads (D272). */
export const SOURCE_LABEL: Record<Skill['source'], string> = {
  builtin: 'Built-in',
  user: 'Yours',
  bundle: 'From a bundle',
};

const errorText = (error: Error | null, fallback: string): string | undefined =>
  error === null ? undefined : AceApiError.is(error) ? error.message : fallback;

/**
 * New, edit or view one skill (D272). Without `skill` it creates one; a user or bundle skill opens
 * for editing; a built-in opens read-only with Duplicate, which makes an editable copy and opens
 * that instead (`onDuplicated`). Saving a new name or new instructions gives the skill a new
 * version; runs that already started keep the text they froze.
 */
export function SkillDialog({
  skill,
  onClose,
  onDuplicated,
}: {
  skill?: Skill;
  onClose: () => void;
  onDuplicated: (copy: Skill) => void;
}) {
  const ids = useId();
  const readOnly = skill?.source === 'builtin';
  const create = useCreateSkill();
  const update = useUpdateSkill();
  const duplicate = useDuplicateSkill();
  const [name, setName] = useState(skill?.name ?? '');
  const [description, setDescription] = useState(skill?.description ?? '');
  const [instructions, setInstructions] = useState(skill?.instructions ?? '');

  const pending = create.isPending || update.isPending;
  const complete = name.trim() !== '' && instructions.trim() !== '';
  const error = errorText(create.error ?? update.error, 'Could not save the skill.');

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (readOnly || !complete) return;
    const body = { name: name.trim(), description: description.trim(), instructions };
    if (skill === undefined) {
      create.mutate(body, {
        onSuccess: (created) => {
          toast.success(`Skill "${created.name}" created`);
          onClose();
        },
      });
    } else {
      update.mutate(
        { id: skill.id, body },
        {
          onSuccess: (saved) => {
            toast.success(`Skill "${saved.name}" saved`, {
              description: `Version ${saved.version}`,
            });
            onClose();
          },
        },
      );
    }
  };

  const copy = () => {
    if (skill === undefined) return;
    duplicate.mutate(skill.id, {
      onSuccess: (created) => {
        toast.success(`Duplicated as "${created.name}"`);
        onDuplicated(created);
      },
    });
  };

  const title = skill === undefined ? 'New skill' : readOnly ? skill.name : 'Edit skill';
  const intro =
    skill === undefined
      ? 'Instructions for a kind of work. Installing a skill enables it for no agent: tick it in an agent’s Skills section.'
      : readOnly
        ? 'A built-in skill is read-only. Duplicate it to make a copy you can edit.'
        : 'A new name or new instructions make a new version. Runs that already started keep the version they began with.';

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-2xl">
        <form onSubmit={submit} className="flex flex-col gap-4" aria-label={title}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{intro}</DialogDescription>
          </DialogHeader>

          {skill !== undefined && (
            <div className="flex flex-wrap items-center gap-2" data-testid="skill-dialog-meta">
              <Badge>{SOURCE_LABEL[skill.source]}</Badge>
              <span className="font-machine text-[11px] text-fg-muted">v{skill.version}</span>
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${ids}-name`}>Name</Label>
            <Input
              id={`${ids}-name`}
              value={name}
              maxLength={SKILL_NAME_MAX}
              readOnly={readOnly}
              onChange={(event) => setName(event.target.value)}
              placeholder="Plain words"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${ids}-description`}>Description</Label>
            <Input
              id={`${ids}-description`}
              value={description}
              maxLength={SKILL_DESCRIPTION_MAX}
              readOnly={readOnly}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="When an agent should use it (optional)"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${ids}-instructions`}>Instructions</Label>
            <Textarea
              id={`${ids}-instructions`}
              value={instructions}
              maxLength={SKILL_INSTRUCTIONS_MAX}
              readOnly={readOnly}
              rows={12}
              className="font-machine text-xs"
              onChange={(event) => setInstructions(event.target.value)}
              placeholder="What the agent should do, step by step…"
            />
            {!readOnly && (
              <p className="text-xs text-fg-muted">
                Added to the prompt of every agent that uses this skill, under “Skills”.
              </p>
            )}
          </div>

          {error !== undefined && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          {duplicate.isError && (
            <p role="alert" className="text-sm text-danger">
              {errorText(duplicate.error, 'Could not duplicate the skill.')}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose}>
              {readOnly ? 'Close' : 'Cancel'}
            </Button>
            {readOnly ? (
              <Button type="button" onClick={copy} disabled={duplicate.isPending}>
                <Copy className="h-4 w-4" aria-hidden /> Duplicate
              </Button>
            ) : (
              <Button type="submit" disabled={pending || !complete}>
                {skill === undefined ? 'Create skill' : 'Save'}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
