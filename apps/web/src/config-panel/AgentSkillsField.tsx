import type { Id } from '@ace/contracts';
import { Badge, Checkbox } from '@ace/ui';
import { Link } from 'react-router-dom';

import { useSkills } from '../library/skills-hooks';

const legendClass = 'mb-1 font-machine text-[10px] uppercase tracking-wider text-fg-muted';

/**
 * Which installed skills the Agent uses (ACE parity P1, D272, FR-SKL-002). A ticked skill's
 * instructions join the agent's prompt under "Skills", in the order they were ticked; a run freezes
 * their text when it starts. A skill removed from the library since it was ticked stays listed, so
 * it can be removed — until it is, pre-flight refuses the run (`missing_skill`).
 */
export function AgentSkillsField({
  value,
  onChange,
}: {
  value: readonly Id[];
  onChange: (skillIds: Id[]) => void;
}) {
  const skills = useSkills();
  const known = new Set((skills.data ?? []).map((skill) => skill.id));
  const missing = skills.data === undefined ? [] : value.filter((id) => !known.has(id));

  const toggle = (id: Id, on: boolean) =>
    onChange(
      on ? [...value.filter((each) => each !== id), id] : value.filter((each) => each !== id),
    );

  return (
    <fieldset className="flex flex-col gap-2" data-testid="agent-skills">
      <legend className={legendClass}>Skills</legend>
      {skills.isPending && <p className="text-xs text-fg-muted">Loading skills…</p>}
      {skills.isError && (
        <p role="alert" className="text-xs text-danger">
          Could not load skills: {skills.error.message}
        </p>
      )}
      {skills.data !== undefined && skills.data.length === 0 && (
        <p className="text-xs text-fg-muted" data-testid="agent-skills-empty">
          No skills installed.
        </p>
      )}
      <div className="flex flex-col gap-2" role="group" aria-label="Skills this agent uses">
        {skills.data?.map((skill) => {
          const boxId = `agent-skill-${skill.id}`;
          return (
            <div key={skill.id} className="flex items-start gap-2" data-testid={boxId}>
              <Checkbox
                id={boxId}
                className="mt-0.5"
                checked={value.includes(skill.id)}
                onCheckedChange={(checked) => toggle(skill.id, checked === true)}
              />
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="flex flex-wrap items-center gap-1.5">
                  <label htmlFor={boxId} className="font-human text-sm text-fg">
                    {skill.name}
                  </label>
                  {skill.source === 'builtin' && <Badge>Built-in</Badge>}
                </span>
                {skill.description !== '' && (
                  <p className="text-xs text-fg-muted">{skill.description}</p>
                )}
              </div>
            </div>
          );
        })}
        {missing.map((id) => (
          <div
            key={id}
            role="alert"
            className="flex items-center gap-2 text-xs text-danger"
            data-testid={`agent-skill-missing-${id}`}
          >
            <span>
              A skill this agent uses is no longer installed; runs are refused until it goes.
            </span>
            <button
              type="button"
              className="ml-auto shrink-0 underline"
              onClick={() => toggle(id, false)}
            >
              Remove
            </button>
          </div>
        ))}
      </div>
      <Link className="self-start text-xs text-accent underline" to="/library/skills">
        Manage skills in the Library
      </Link>
    </fieldset>
  );
}
