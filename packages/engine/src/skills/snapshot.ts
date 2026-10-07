import type { Id, Node, RunSnapshot, SnapshotSkill } from '@ace/contracts';

import type { Scope, SkillRepository } from '../ports/index.js';

/**
 * Skills in a run (D272, BR-04). `beginRun` freezes the text of every skill the run's agents name
 * into the snapshot, inside the transaction that writes the run row; from then on the run reads
 * only the snapshot, so editing or deleting a skill never changes what a started run is asked.
 */

/** The skill ids the agents name, each once, in the order they are first named. */
export function skillIdsOf(nodes: readonly Node[]): Id[] {
  const ids = new Set<Id>();
  for (const node of nodes) {
    if (node.kind !== 'agent') continue;
    // A node stored before skills existed may lack the field the contract now defaults.
    for (const id of node.config.skillIds ?? []) ids.add(id);
  }
  return [...ids];
}

/**
 * What a new run's snapshot carries under `skills`: one entry per installed skill an agent names.
 * Absent when no agent names a skill, so a run without skills keeps the snapshot shape it always
 * had. A skill that is not installed is simply missing here, and pre-flight reports it
 * (`missing_skill`); a store without skills holds none.
 */
export async function freezeSkills(
  nodes: readonly Node[],
  skills: SkillRepository | undefined,
  scope: Scope,
): Promise<SnapshotSkill[] | undefined> {
  const ids = skillIdsOf(nodes);
  if (ids.length === 0) return undefined;

  const frozen: SnapshotSkill[] = [];
  for (const id of ids) {
    const skill = (await skills?.get(scope, id)) ?? null;
    if (skill === null) continue;
    frozen.push({
      id: skill.id,
      name: skill.name,
      version: skill.version,
      instructions: skill.instructions,
    });
  }
  return frozen;
}

/** One agent's skills as its prompt renders them: from the snapshot, in its `skillIds` order. */
export function skillsForNode(node: Node, snapshot: RunSnapshot): SnapshotSkill[] {
  if (node.kind !== 'agent' || snapshot.skills === undefined) return [];
  const byId = new Map(snapshot.skills.map((skill) => [skill.id, skill]));
  return [...new Set(node.config.skillIds ?? [])].flatMap((id) => {
    const skill = byId.get(id);
    return skill === undefined ? [] : [skill];
  });
}
