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
 * sandbox", but `run_command` is an unsandboxed shell that starts in the project folder and asks
 * before every call (D266, D288) — a safety property the screen must not overstate. D346 (PG-5.3):
 * it is not confined to the folder either, and the screen says so plainly.
 */
const DESCRIPTION_OVERRIDE: Readonly<Record<string, string>> = {
  shell: 'Run shell commands as you, starting in the project folder; each one asks first',
};

/**
 * D346: what a person must know before turning shell commands on — they are not confined to the
 * project folder. Shown under the skills while the Shell skill is on.
 */
export const RUN_COMMAND_REACH =
  'Shell commands are not confined to the project folder: they run as you and can read, change or delete anything you can, anywhere on this computer. ACE asks before each one, so read the command before you approve it.';

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
  hide = [],
  onChange,
}: {
  skills: readonly Skill[];
  /** Skill ids not shown: Files and Shell, once the node has workspace access (D342). */
  hide?: readonly string[];
  tools: ToolsConfig;
  onChange: (tools: ToolsConfig) => void;
}) {
  const shown = skills.filter((skill) => !hide.includes(skill.id));
  if (shown.length === 0) return null;

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
        {shown.map((skill) => {
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
      {shown.some(
        (skill) =>
          skill.id === 'shell' && skill.tools.every((name) => tools.enabled.includes(name)),
      ) && (
        <p
          role="note"
          data-testid="skill-shell-reach"
          className="m-0 rounded-[9px] border border-[rgba(201,76,39,0.35)] bg-[rgba(201,76,39,0.08)] px-3 py-2 text-[11px] leading-[1.45] text-[var(--ink)]"
        >
          {RUN_COMMAND_REACH}
        </p>
      )}
    </div>
  );
}
