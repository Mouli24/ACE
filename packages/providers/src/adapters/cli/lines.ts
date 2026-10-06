/**
 * Coding-agent CLIs speak JSONL on stdout (X1 spec §5). A read can end mid-line and a CLI can print
 * a banner or warning between events, so lines are reassembled first and a line that is not a JSON
 * object is skipped — never fatal (review focus 5).
 */
export function createLineSplitter(): { push(chunk: string): string[]; end(): string[] } {
  let rest = '';
  return {
    push(chunk) {
      rest += chunk;
      const parts = rest.split(/\r?\n/);
      rest = parts.pop() ?? '';
      return parts.filter((line) => line.trim() !== '');
    },
    end() {
      const last = rest.trim();
      rest = '';
      return last === '' ? [] : [last];
    },
  };
}

export function parseJsonLine(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return undefined;
  try {
    const value: unknown = JSON.parse(trimmed);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
