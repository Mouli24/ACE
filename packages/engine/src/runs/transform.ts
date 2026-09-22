import type { Part, TransformConfig } from '@ace/contracts';

/**
 * The transform node (FR-NODE-013, OI-06: template, JSON extract, join).
 *
 * Pure, local and free — a transform never calls a provider, which is exactly why it exists: the
 * cheap reshaping between two agents should not cost a model call.
 */

export type TransformResult = { ok: true; parts: Part[] } | { ok: false; reason: string };

/** `{{a.field}}` over the JSON reads, resolved by dotted path. */
const TEMPLATE_SLOT = /\{\{\s*([A-Za-z0-9_.[\]]+)\s*\}\}/g;

/**
 * A JSONPath-lite dotted path: `a.b.c`, with `a.0` or `a[0]` for an array index. Deliberately not
 * full JSONPath — a filter expression in a workflow config is a small programming language, and
 * the one thing a transform must be is predictable.
 */
export function readPath(value: unknown, path: string): unknown {
  const segments = path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter((segment) => segment !== '');

  let current = value;
  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
      continue;
    }
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** How a resolved value is written into a template: strings as themselves, the rest as JSON. */
function render(value: unknown): string {
  if (value === undefined) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** The first json read, which is what the dotted paths are resolved against. */
function jsonSource(reads: readonly Part[]): unknown {
  const json = reads.find((part) => part.type === 'json');
  if (json !== undefined && json.type === 'json') return json.value;

  // A text read that happens to be JSON is still JSON to a transform — an upstream agent that
  // produced a JSON string should not need a parse node in between.
  const text = reads.find((part) => part.type === 'text');
  if (text !== undefined && text.type === 'text') {
    try {
      return JSON.parse(text.text);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export const DEFAULT_JOIN_SEPARATOR = '\n\n';

export function runTransform(config: TransformConfig, reads: readonly Part[]): TransformResult {
  switch (config.op) {
    case 'template': {
      if (config.template === undefined) {
        return { ok: false, reason: 'This transform has no template to fill in.' };
      }
      const source = jsonSource(reads);
      const filled = config.template.replace(TEMPLATE_SLOT, (_whole, path: string) =>
        render(readPath(source, path)),
      );
      return { ok: true, parts: [{ type: 'text', text: filled }] };
    }

    case 'extract_json_field': {
      if (config.path === undefined || config.path === '') {
        return { ok: false, reason: 'This transform has no path to extract.' };
      }
      const value = readPath(jsonSource(reads), config.path);
      if (value === undefined) {
        return { ok: false, reason: `The input has nothing at "${config.path}".` };
      }
      return { ok: true, parts: [{ type: 'json', value }] };
    }

    case 'join': {
      const separator = config.separator ?? DEFAULT_JOIN_SEPARATOR;
      const texts = reads.flatMap((part) => (part.type === 'text' ? [part.text] : []));
      return { ok: true, parts: [{ type: 'text', text: texts.join(separator) }] };
    }
  }
}
