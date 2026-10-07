import type { Node } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { createRunDriverHarness, deferred, scope } from '../../__tests__/run-driver-harness.js';
import { BUILTIN_SKILL_IDS, BUILTIN_SKILLS } from '../builtin.js';
import { createSkillService } from '../service.js';
import { freezeSkills, skillIdsOf, skillsForNode } from '../snapshot.js';
import { withSkills } from './harness.js';

/**
 * D272 end to end on the run driver (BR-04, FR-PRM-001): `beginRun` freezes the text of every skill
 * the run's agents use into the snapshot; each agent's prompt carries its own skills from that
 * snapshot, in its `skillIds` order; editing a skill while the run is going changes neither the
 * stored snapshot nor a prompt assembled after the edit; and a skill that is not installed blocks
 * the run at pre-flight with no provider call.
 */

const withSkillIds = (node: Node, skillIds: string[]): Node => {
  if (node.kind !== 'agent') throw new Error('not an agent');
  return { ...node, config: { ...node.config, skillIds } };
};

async function setUp() {
  const h = await createRunDriverHarness();
  withSkills(h.repository);
  const skills = createSkillService({ repository: h.repository, scope });
  await skills.ensureBuiltinSkills();
  const house = await skills.create({
    name: 'House style',
    instructions: 'Use British spelling.\nKeep sentences short.',
  });
  return { h, skills, house };
}

const testFirst = BUILTIN_SKILLS.find((skill) => skill.id === BUILTIN_SKILL_IDS.testFirst)!;

describe('D272 BR-04 a run freezes its skills and its agents use them', () => {
  it('snapshots the skills agents name and renders each agent its own, in its order', async () => {
    const { h, house } = await setUp();
    const input = h.inputNode();
    const writer = withSkillIds(h.agentNode('Writer'), [house.id, testFirst.id]);
    const reviewer = withSkillIds(h.agentNode('Reviewer'), [testFirst.id]);
    const plain = h.agentNode('Plain');
    const output = h.outputNode();
    await h.seed(
      [input, writer, reviewer, plain, output],
      [
        h.edge(input, writer),
        h.edge(writer, reviewer),
        h.edge(reviewer, plain),
        h.edge(plain, output),
      ],
    );

    const { run, done } = await h.service.beginRun(h.workflowId, {});
    expect((await done).status).toBe('COMPLETE');

    // Frozen once each, in the order first named, with the version the prompt version folds in.
    expect(run.snapshot.skills).toEqual([
      { id: house.id, name: 'House style', version: 1, instructions: house.instructions },
      {
        id: testFirst.id,
        name: 'Test first',
        version: 1,
        instructions: testFirst.instructions,
      },
    ]);
    expect((await h.runRow(run.id)).snapshot.skills).toEqual(run.snapshot.skills);

    const promptOf = async (node: Node) => (await h.nodeRunsOf(run.id, node.id))[0]!.prompt!;
    const writerPrompt = (await promptOf(writer)).text;
    expect(writerPrompt).toContain(
      `## Skills\n### House style\n${house.instructions}\n\n### Test first\n${testFirst.instructions}\n`,
    );
    const reviewerPrompt = (await promptOf(reviewer)).text;
    expect(reviewerPrompt).toContain(`## Skills\n### Test first\n${testFirst.instructions}\n`);
    expect(reviewerPrompt).not.toContain('### House style');
    // An agent with no skills has the empty section, exactly as before skills existed.
    expect((await promptOf(plain)).text).toContain('## Skills\n\n## Guardrails');

    // The version covers the skills: same instructions, different skills, different version.
    expect((await promptOf(writer)).version).not.toBe((await promptOf(plain)).version);
  });

  it('keeps the snapshot and later prompts as frozen when a skill is edited mid-run', async () => {
    const { h, skills, house } = await setUp();
    const input = h.inputNode();
    const writer = withSkillIds(h.agentNode('Writer'), [house.id]);
    const reviewer = withSkillIds(h.agentNode('Reviewer'), [house.id]);
    const output = h.outputNode();
    await h.seed(
      [input, writer, reviewer, output],
      [h.edge(input, writer), h.edge(writer, reviewer), h.edge(reviewer, output)],
    );
    const hold = deferred();
    h.scripts.set('Writer', [{ text: 'draft', hold: hold.promise }]);

    const { run, done } = await h.service.beginRun(h.workflowId, {});
    await h.waitFor(() => h.calls('Writer') === 1, 'the writer to call its model');

    // Edited while the writer is working, and before the reviewer's prompt is assembled.
    const edited = await skills.update(house.id, { instructions: 'Use American spelling.' });
    expect(edited.version).toBe(2);
    hold.resolve();
    expect((await done).status).toBe('COMPLETE');

    expect((await h.runRow(run.id)).snapshot.skills).toEqual([
      { id: house.id, name: 'House style', version: 1, instructions: house.instructions },
    ]);
    const reviewerPrompt = (await h.nodeRunsOf(run.id, reviewer.id))[0]!.prompt!.text;
    expect(reviewerPrompt).toContain(house.instructions);
    expect(reviewerPrompt).not.toContain('American');

    // The next run takes the skill as it now stands.
    const next = await h.service.beginRun(h.workflowId, {});
    await next.done;
    expect(next.run.snapshot.skills).toEqual([
      { id: house.id, name: 'House style', version: 2, instructions: 'Use American spelling.' },
    ]);
  });

  it('blocks a run whose agent names a skill that is not installed, before any call', async () => {
    const { h, skills, house } = await setUp();
    const input = h.inputNode();
    const writer = withSkillIds(h.agentNode('Writer'), [house.id]);
    const output = h.outputNode();
    await h.seed([input, writer, output], [h.edge(input, writer), h.edge(writer, output)]);
    await skills.remove(house.id);

    const { run, done } = await h.service.beginRun(h.workflowId, {});
    const ended = await done;
    expect(ended.status).toBe('BLOCKED');
    expect(ended.preflightIssues).toEqual([
      {
        severity: 'error',
        code: 'missing_skill',
        message: 'Agent "Writer" uses a skill that is not installed.',
        nodeId: writer.id,
      },
    ]);
    expect(run.snapshot.skills).toEqual([]);
    expect(h.calls('Writer')).toBe(0);
  });

  it('leaves the snapshot shape unchanged when no agent names a skill', async () => {
    const { h } = await setUp();
    const input = h.inputNode();
    const writer = h.agentNode('Writer');
    const output = h.outputNode();
    await h.seed([input, writer, output], [h.edge(input, writer), h.edge(writer, output)]);

    const { run, done } = await h.service.beginRun(h.workflowId, {});
    expect((await done).status).toBe('COMPLETE');
    expect(Object.keys(run.snapshot).sort()).toEqual(['edges', 'nodes', 'version']);
  });
});

describe('D272 the snapshot helpers', () => {
  it('reads nothing from a store without skills, and freezes none of what an agent names', async () => {
    const h = await createRunDriverHarness();
    const writer = withSkillIds(h.agentNode('Writer'), [testFirst.id, testFirst.id]);
    expect(skillIdsOf([h.inputNode(), writer])).toEqual([testFirst.id]);
    expect(await freezeSkills([writer], undefined, scope)).toEqual([]);
    expect(await freezeSkills([h.agentNode('Plain')], undefined, scope)).toBeUndefined();
  });

  it('renders a skill named twice once, and nothing for a node that is not an agent', async () => {
    const h = await createRunDriverHarness();
    const writer = withSkillIds(h.agentNode('Writer'), [testFirst.id, testFirst.id]);
    const snapshot = {
      version: 1,
      nodes: [writer],
      edges: [],
      skills: [{ id: testFirst.id, name: 'Test first', version: 1, instructions: 'x' }],
    };
    expect(skillsForNode(writer, snapshot)).toHaveLength(1);
    expect(skillsForNode(h.inputNode(), snapshot)).toEqual([]);
    expect(skillsForNode(writer, { version: 1, nodes: [writer], edges: [] })).toEqual([]);
  });
});
