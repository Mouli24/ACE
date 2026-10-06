import type { TaskCheck } from '@ace/contracts';

/**
 * Design §5: what the checks say about a commit is the latest result per check name *for that
 * commit* — a check of an earlier head says nothing about a later one. Without a head (no workspace)
 * the newest commit any check ran on stands in for it.
 */
export function splitChecks(
  checks: readonly TaskCheck[],
  headSha: string | undefined,
): { headSha: string | undefined; latest: TaskCheck[]; older: TaskCheck[] } {
  const head =
    headSha ?? [...checks].sort((a, b) => b.at.localeCompare(a.at)).at(0)?.headSha ?? undefined;
  const latestByName = new Map<string, TaskCheck>();
  for (const check of checks) {
    if (check.headSha !== head) continue;
    const seen = latestByName.get(check.name);
    if (seen === undefined || seen.at <= check.at) latestByName.set(check.name, check);
  }
  const latest = [...latestByName.values()];
  const kept = new Set(latest.map((check) => check.id));
  const older = checks
    .filter((check) => !kept.has(check.id))
    .sort((a, b) => b.at.localeCompare(a.at));
  return { headSha: head, latest, older };
}

/** "Checks failed" as Apply and Autopilot read it: a latest result for the head that did not pass. */
export function headChecksFailed(checks: readonly TaskCheck[], headSha: string): boolean {
  return splitChecks(checks, headSha).latest.some((check) => check.status !== 'passed');
}
