import type { DebateRole } from '@ace/contracts';

/**
 * Debates (D405, D406): two Agents argue over the person's request, round by round, and the answer
 * that survives is the result — written by the Judge when the debate has one.
 *
 * The rules of the debate live here, in the engine, never in a node's config: whose turn it is,
 * what each turn must do, and how a side argues. The prompts are the product's own and are never
 * sent to the client (D406). A node's own instructions still reach the model, after them, as the
 * person's brief for that debater.
 */

/** How each side argues — the same for a preset node and for any Agent seated on a debate edge. */
const ROLE_PROMPT: Record<DebateRole, string> = {
  defender: [
    'You are the Defender in a structured debate between AI agents. The person asked for something,',
    'and you own the answer.',
    '',
    'How you work:',
    '- Write the strongest answer you can: complete, specific and ready to use. Prefer concrete',
    '  decisions, numbers, examples and acceptance criteria to general advice.',
    '- When the Attacker criticises your answer, weigh every point on its merits. Concede and fix the',
    '  points that are right, without apologising. Push back on the points that are wrong, and say why.',
    '- Never give in just to agree, and never defend something you know is weak.',
    '- Every time you answer, give the complete current answer, never a list of changes on its own.',
  ].join('\n'),
  attacker: [
    'You are the Attacker in a structured debate between AI agents. Your job is to find what is wrong',
    "with the Defender's latest answer before anyone relies on it.",
    '',
    'How you work:',
    '- Look for claims that are wrong or unsupported, missing requirements or cases, hidden',
    '  assumptions, risks, contradictions, parts too vague to act on, and better alternatives.',
    '- Be specific: point to the exact part, say why it fails, and say what would fix it.',
    '- Rank your points by impact and give at most seven. No praise, no padding, and do not rewrite',
    '  the answer yourself.',
    '- If the Defender answered one of your earlier points well, drop it. If they dodged it, press it',
    '  again.',
    '- If nothing important is left to fix, say so plainly instead of inventing objections.',
  ].join('\n'),
  judge: [
    'You are the Judge of a structured debate between AI agents. You took no part in it.',
    '',
    'How you work:',
    '- Read the whole debate. For each point the two sides disagreed on, decide who was right and why,',
    '  in a line or two.',
    "- Then write the final answer: the Defender's latest answer, with every point the Attacker won",
    '  fixed and nothing the Defender rightly defended lost.',
    '- Your reply has two parts: "## Verdict" (at most six short points), then "## Final answer" (the',
    '  complete final answer, ready to use).',
  ].join('\n'),
};

/** One turn of a debate, in the order they are taken. */
export interface DebateStep {
  role: DebateRole;
  /** 1-based; absent for the Defender's opening answer and the Judge's verdict. */
  round?: number;
  /** What the moderator says to the speaker: the turn's own instruction, seen as the latest line. */
  cue: string;
}

/**
 * The turns of a debate with `rounds` rounds: the opening answer, an attack and a defence per round,
 * then the verdict when there is a judge. Without one, the Defender's last answer is the result, so
 * that turn is asked for the clean final answer and nothing about the debate.
 */
export function debateSteps(rounds: number, judged: boolean): DebateStep[] {
  const steps: DebateStep[] = [
    {
      role: 'defender',
      cue:
        "(Debate moderator) Opening. You are the Defender. Answer the person's request above in " +
        'full. The Attacker will look for its flaws next.',
    },
  ];
  for (let round = 1; round <= rounds; round += 1) {
    const of = `Round ${round} of ${rounds}`;
    steps.push({
      role: 'attacker',
      round,
      cue: `(Debate moderator) ${of}. You are the Attacker. Attack the Defender's latest answer above.`,
    });
    const last = round === rounds;
    steps.push({
      role: 'defender',
      round,
      cue:
        last && !judged
          ? `(Debate moderator) ${of}, the last. You are the Defender. Take the Attacker's points ` +
            'above into account and give the final answer: complete and ready to use. Give only ' +
            'the answer, with nothing about the debate.'
          : `(Debate moderator) ${of}. You are the Defender. Start with a few short lines on which ` +
            "of the Attacker's points you accept and which you reject, and why. Then give your " +
            'complete revised answer.',
    });
  }
  if (judged) {
    steps.push({
      role: 'judge',
      cue: '(Debate moderator) The debate above is over. You are the Judge: give your verdict and the final answer.',
    });
  }
  return steps;
}

/**
 * What a debater is told, in its prompt's instructions: how its side argues, then the person's own
 * brief for that node when there is one (D406: what they add on top, never in place of it).
 */
export function debateInstructions(role: DebateRole, ownInstructions: string): string {
  const own = ownInstructions.trim();
  return own === ''
    ? ROLE_PROMPT[role]
    : `${ROLE_PROMPT[role]}\n\nYour brief from the person who set you up:\n${own}`;
}
