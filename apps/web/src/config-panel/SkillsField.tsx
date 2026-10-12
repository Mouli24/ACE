import type { AgentConfig } from '@ace/contracts';
import { FIELD_LABEL_CLASS } from '@ace/ui';
import { useMemo } from 'react';

import { useTools } from '../library/tools-hooks';
import { SKILLS } from '../theme/constants';
import { Toggle } from '../theme/primitives';

type ToolsConfig = AgentConfig['tools'];

/**
 * D333: the theme's skills are groups of ACE tools. A skill is on when every one of its tools is in
 * `tools.enabled`, and toggling it adds or removes them all. The theme's Citations skill has no
 * tool behind it, so it is not offered.
 */
export const SKILL_TOOLS: Readonly<Record<string, readonly string[]>> = {
  web: ['web_search', 'web_fetch'],
  files: ['write_file', 'edit_file'],
  shell: ['run_command'],
};

/**
 * Where the theme's description would misstate what ACE does. Its "Run commands" says "inside the
 * sandbox", but `run_command` is an unsandboxed shell in the project folder that asks before every
 * call (D266, D288) — a safety property the screen must not overstate.
 */
const DESCRIPTION_OVERRIDE: Readonly<Record<string, string>> = {
  shell: 'Run shell commands in the project folder; each one asks first',
};

export interface Skill {
  id: string;
  label: string;
  description: string;
  tools: readonly string[];
}

/** The skills whose tools are all in the registry, in the theme's order. */
export function useSkills(): Skill[] {
  const registry = useTools();
  return useMemo(() => {
    const registered = new Set((registry.data ?? []).map((tool) => tool.name));
    return SKILLS.flatMap(([id, label, description]) => {
      const tools = SKILL_TOOLS[id];
      if (tools === undefined || !tools.every((name) => registered.has(name))) return [];
      return [{ id, label, description: DESCRIPTION_OVERRIDE[id] ?? description, tools }];
    });
  }, [registry.data]);
}

/** The theme's Skills grid (Ace Canvas 328–342): one switch row per skill. */
export function SkillsField({
  skills,
  tools,
  onChange,
}: {
  skills: readonly Skill[];
  tools: ToolsConfig;
  onChange: (tools: ToolsConfig) => void;
}) {
  if (skills.length === 0) return null;

  const toggle = (skill: Skill, on: boolean) => {
    const rest = tools.enabled.filter((name) => !skill.tools.includes(name));
    onChange({ ...tools, enabled: on ? [...rest, ...skill.tools] : rest });
  };

  return (
    <div className="flex flex-col gap-[7px]" data-testid="agent-skills">
      <span id="agent-skills-label" className={FIELD_LABEL_CLASS}>
        Skills
      </span>
      <div
        role="group"
        aria-labelledby="agent-skills-label"
        className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-2"
      >
        {skills.map((skill) => {
          const on = skill.tools.every((name) => tools.enabled.includes(name));
          return (
            <button
              key={skill.id}
              type="button"
              role="switch"
              aria-checked={on}
              data-testid={`skill-${skill.id}`}
              onClick={() => toggle(skill, !on)}
              className="flex cursor-pointer items-center gap-2.5 rounded-[9px] border border-[var(--line)] bg-transparent px-3 py-2.5 text-left text-[var(--ink)] outline-none hover:bg-[var(--hover)] focus-visible:border-[#ef6b3f]"
            >
              <div className="min-w-0 flex-1">
                <div className="text-[12.5px] font-semibold">{skill.label}</div>
                <div className="mt-px text-[10.5px] text-[var(--muted)]">{skill.description}</div>
              </div>
              <Toggle on={on} />
            </button>
          );
        })}
      </div>
    </div>
  );
}
