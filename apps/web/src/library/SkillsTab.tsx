import type { Skill } from '@ace/contracts';
import { Badge, Button, toast } from '@ace/ui';
import { Copy, Plus, Sparkles, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { ConfirmDialog } from '../knowledge/ConfirmDialog';
import { SkillDialog, SOURCE_LABEL } from './SkillDialog';
import { useDeleteSkill, useDuplicateSkill, useSkills } from './skills-hooks';

/** Which dialog is open: a new skill, or one skill to edit or read. */
type Open = { kind: 'new' } | { kind: 'skill'; skill: Skill };

/**
 * Library › Skills (ACE parity P1, D272, FR-SKL-001..003): every installed skill, built-ins first,
 * with its source and version. A user or bundle skill opens for editing; a built-in opens
 * read-only, with Duplicate. Installing a skill enables it for no agent — that is the agent's
 * Skills section.
 */
export function SkillsTab() {
  const skills = useSkills();
  const remove = useDeleteSkill();
  const duplicate = useDuplicateSkill();
  const [open, setOpen] = useState<Open | null>(null);
  const [deleting, setDeleting] = useState<Skill | null>(null);

  const duplicateRow = (skill: Skill) =>
    duplicate.mutate(skill.id, {
      onSuccess: (copy) => toast.success(`Duplicated as "${copy.name}"`),
      onError: (error) =>
        toast.error('Could not duplicate the skill', { description: error.message }),
    });

  const confirmDelete = () => {
    if (deleting === null) return;
    remove.mutate(deleting.id, {
      onSuccess: () => {
        toast.success(`Skill "${deleting.name}" deleted`);
        setDeleting(null);
      },
    });
  };

  return (
    <section className="flex flex-col gap-4" data-testid="skills-tab">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="font-human text-lg font-semibold">Skills</h2>
          <p className="mt-1 font-human text-sm text-fg-muted">
            Reusable instructions for a kind of work. An agent uses a skill only once you tick it in
            the agent’s Skills section. Built-in skills are read-only; duplicate one to make it your
            own.
          </p>
        </div>
        <Button onClick={() => setOpen({ kind: 'new' })} className="self-start">
          <Plus className="h-4 w-4" aria-hidden /> New skill
        </Button>
      </header>

      {skills.isPending && <p className="text-fg-muted">Loading skills…</p>}
      {skills.isError && (
        <p role="alert" className="text-danger">
          Could not load skills: {skills.error.message}
        </p>
      )}
      {skills.data?.length === 0 && (
        <div
          data-testid="skills-empty"
          className="flex flex-col items-center gap-3 rounded-card border border-dashed border-border p-8 text-center"
        >
          <Sparkles className="h-6 w-6 text-fg-muted" aria-hidden />
          <p className="font-human text-fg-muted">No skills installed yet.</p>
          <Button variant="secondary" onClick={() => setOpen({ kind: 'new' })}>
            Write your first skill
          </Button>
        </div>
      )}

      {skills.data && skills.data.length > 0 && (
        <ul aria-label="Skills" className="flex flex-col gap-2">
          {skills.data.map((skill) => (
            <li
              key={skill.id}
              data-testid={`skill-row-${skill.id}`}
              data-source={skill.source}
              className="flex flex-col gap-3 rounded-card border border-border bg-panel px-4 py-3 sm:flex-row sm:items-center"
            >
              <button
                type="button"
                onClick={() => setOpen({ kind: 'skill', skill })}
                aria-label={`${skill.source === 'builtin' ? 'View' : 'Edit'} ${skill.name}`}
                className="min-w-0 flex-1 rounded-chip text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <span className="flex flex-wrap items-center gap-2">
                  <span className="truncate font-human font-semibold">{skill.name}</span>
                  {skill.source !== 'user' && <Badge>{SOURCE_LABEL[skill.source]}</Badge>}
                  <span className="font-machine text-[11px] text-fg-muted">v{skill.version}</span>
                </span>
                {skill.description !== '' && (
                  <span className="mt-0.5 block font-human text-sm text-fg-muted">
                    {skill.description}
                  </span>
                )}
              </button>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={duplicate.isPending}
                  onClick={() => duplicateRow(skill)}
                  aria-label={`Duplicate ${skill.name}`}
                >
                  <Copy className="h-4 w-4" aria-hidden /> Duplicate
                </Button>
                {skill.source !== 'builtin' && (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Delete ${skill.name}`}
                    onClick={() => setDeleting(skill)}
                  >
                    <Trash2 className="h-4 w-4 text-danger" aria-hidden />
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {open !== null && (
        <SkillDialog
          key={open.kind === 'new' ? 'new' : open.skill.id}
          {...(open.kind === 'skill' ? { skill: open.skill } : {})}
          onClose={() => setOpen(null)}
          onDuplicated={(copy) => setOpen({ kind: 'skill', skill: copy })}
        />
      )}

      {deleting !== null && (
        <ConfirmDialog
          title={`Delete "${deleting.name}"?`}
          description="Agents that still use it are stopped at pre-flight until you untick it in their Skills section. Runs that already started keep their copy."
          confirmLabel="Delete skill"
          pending={remove.isPending}
          error={remove.error}
          onConfirm={confirmDelete}
          onClose={() => {
            remove.reset();
            setDeleting(null);
          }}
        />
      )}
    </section>
  );
}
