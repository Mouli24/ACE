/**
 * A score for `path` against `query` (higher is better), or `undefined` when the query's letters do
 * not all appear in order. Letters in the file name, letters in a row, and letters at a word start
 * (after `/ . - _`, or a camelCase hump) score more — VS Code's quick open in miniature.
 */
export function fuzzyScore(query: string, path: string): number | undefined {
  const wanted = query.toLowerCase().replace(/\s+/g, '');
  if (wanted === '') return 0;
  const haystack = path.toLowerCase();
  const nameStart = path.lastIndexOf('/') + 1;
  let score = 0;
  let from = 0;
  let previous = -2;
  for (const letter of wanted) {
    const found = haystack.indexOf(letter, from);
    if (found === -1) return undefined;
    score += 1;
    if (found === previous + 1) score += 5;
    if (found >= nameStart) score += 2;
    const before = path[found - 1];
    const here = path[found] ?? '';
    const hump =
      before !== undefined && before === before.toLowerCase() && here !== here.toLowerCase();
    if (found === 0 || before === '/' || before === '.' || before === '-' || before === '_' || hump)
      score += 2;
    previous = found;
    from = found + 1;
  }
  return score * 100 - path.length;
}

export function rankPaths(query: string, paths: readonly string[], limit = 50): string[] {
  if (query.trim() === '') return paths.slice(0, limit);
  return paths
    .map((path) => ({ path, score: fuzzyScore(query, path) }))
    .filter((entry): entry is { path: string; score: number } => entry.score !== undefined)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.path);
}
