import { normaliseAnswer } from '@ace/contracts';

/**
 * D348 DB9: the no-debate baseline every choice debate carries, computed in code with no model.
 * The majority of the openings' answers, as the option it matches, or `tie` when no single
 * answer has the most votes (no openings at all is a tie too).
 */
export function openingsMajority(answers: readonly string[], options: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const answer of answers) {
    const key = normaliseAnswer(answer);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestCount = 0;
  let tied = false;
  for (const [key, count] of counts) {
    if (count > bestCount) {
      best = key;
      bestCount = count;
      tied = false;
    } else if (count === bestCount) {
      tied = true;
    }
  }
  if (best === undefined || tied) return 'tie';
  return options.find((option) => normaliseAnswer(option) === best) ?? best;
}

/** Does the verdict differ from the openings' majority? Undefined for a tie: there was none. */
export function changedFromOpenings(verdict: string, majority: string): boolean | undefined {
  if (majority === 'tie') return undefined;
  return normaliseAnswer(verdict) !== normaliseAnswer(majority);
}
