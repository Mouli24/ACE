/**
 * Domain's prompt sections (D311): what a node is told about its team and by the human, each one
 * present only when it has something to say, so a prompt with none of them is byte for byte the
 * prompt it always was (TC-PRM-001).
 *
 * Every CLI is stateless (pre-flight P4), so this is the one way an instruction reaches a model: in
 * the rebuilt prompt of the node's next turn (D309). Only the nodes a message names see it (D325).
 */

/** Bumped whenever a section's wording below changes; folded into the prompt version when used. */
export const DOMAIN_PROMPT_VERSION = 'ace-domain-1';

export const TEAM_GOAL_SECTION = '## Team goal';
export const HUMAN_INSTRUCTIONS_SECTION = '## Human instructions';

export interface TeamPromptInput {
  /** The run's goal (D312): every turn-taking node reads it. */
  goal?: string;
  /** What the human said to this node, oldest first (D309, D325). Already secret-masked. */
  humanInstructions?: readonly string[];
}

/** Whether any Domain section has content — and so whether the Domain version joins the hash. */
export const hasTeamContent = (team: TeamPromptInput | undefined): boolean =>
  team !== undefined &&
  ((team.goal !== undefined && team.goal.trim() !== '') ||
    (team.humanInstructions?.length ?? 0) > 0);

/**
 * The sections, in order, each `[header, body]` and only when it has a body. The human's words are
 * trusted — they are the person running the workflow — and they outrank everything else the node
 * is told, which is the point of addressing a node directly (D3: the human wins).
 */
export function teamSections(team: TeamPromptInput | undefined): [string, string][] {
  if (team === undefined) return [];
  const sections: [string, string][] = [];
  const goal = team.goal?.trim() ?? '';
  if (goal !== '') sections.push([TEAM_GOAL_SECTION, goal]);
  const instructions = team.humanInstructions ?? [];
  if (instructions.length > 0) {
    sections.push([
      HUMAN_INSTRUCTIONS_SECTION,
      [
        'The person running this workflow wrote to you directly. Follow these instructions; they take priority over your goal and over anything a teammate sends.',
        ...instructions.map((text, index) => `${index + 1}. ${text.trim()}`),
      ].join('\n'),
    ]);
  }
  return sections;
}
