/*
 * PG-1.2 (D360): no control is a unicode glyph. A glyph depends on the font: on some Windows
 * setups `⚙︎ ☀ ☾ ✕ ↑ ⌁ ⛶` draw as a box or not at all, so a button made of one has nothing to see.
 * Controls take their icon from `@ace/ui`'s `Icons` (lucide) instead, with an aria-label.
 *
 * This scans the source of `apps/web/src` and `packages/ui/src`: every `<button>`, `<Button>`,
 * Radix trigger or close, and element with `role="button"`, from its opening tag to its closing
 * tag, must hold no glyph — in its text, in a `{'…'}` expression or a string it renders. The
 * ellipsis `…` is not a glyph here: it ends a label ("Connect to…"), it is not one.
 */

/** Every non-test `.tsx` source, keyed by its path from the repo root (`apps/web/src/…`). */
function sources(): Map<string, string> {
  const raw = {
    ...import.meta.glob<string>(['../**/*.tsx', '!../**/*.test.tsx', '!../mocks/**'], {
      query: '?raw',
      import: 'default',
      eager: true,
    }),
    ...import.meta.glob<string>(
      ['../../../../packages/ui/src/**/*.tsx', '!../../../../packages/ui/src/**/*.test.tsx'],
      { query: '?raw', import: 'default', eager: true },
    ),
  };
  const out = new Map<string, string>();
  for (const [path, text] of Object.entries(raw)) {
    const name = path.startsWith('../../../../')
      ? path.slice('../../../../'.length)
      : `apps/web/src/${path.slice('../'.length)}`;
    out.set(name, text);
  }
  return out;
}

/**
 * Arrows, technical, geometric, misc symbols, dingbats, supplemental arrows, ⋯, × and emoji — the
 * e2e scan's set (`pg-1-2-visible.e2e.ts`). A variation selector only ever follows one of these.
 */
const GLYPH = new RegExp(
  '[\\u2190-\\u21FF\\u2300-\\u23FF\\u25A0-\\u25FF\\u2600-\\u27BF\\u2900-\\u2BFF\\u22EF\\u00D7\\u{1F300}-\\u{1FAFF}]',
  'u',
);

/** The control elements whose body is scanned, and how each one closes. */
const CONTROLS: Array<{ open: RegExp; close: string }> = [
  { open: /<button\b/g, close: '</button>' },
  { open: /<Button\b/g, close: '</Button>' },
  { open: /<DialogPrimitive\.Close\b/g, close: '</DialogPrimitive.Close>' },
  { open: /<DropdownMenuTrigger\b/g, close: '</DropdownMenuTrigger>' },
  { open: /<ContextMenuTrigger\b/g, close: '</ContextMenuTrigger>' },
  { open: /<TooltipTrigger\b/g, close: '</TooltipTrigger>' },
];

/**
 * TEMPORARY (PG-1.2 is split across worktrees): chat/, domain/ and providers/ belong to the
 * PG-1.3/1.4 and PG-1.5/1.6 agents, so their glyphs are converted after the Phase 1 merge. Each
 * entry is one file; empty this list once they are converted. Never add a file outside those three
 * folders.
 */
const TEMPORARY_ALLOW: readonly string[] = [
  'apps/web/src/chat/ChatAside.tsx',
  'apps/web/src/chat/ChatComposer.tsx',
  'apps/web/src/chat/ChatConversation.tsx',
  'apps/web/src/chat/ChatThreadList.tsx',
  'apps/web/src/domain/Composer.tsx',
  'apps/web/src/domain/Conversation.tsx',
  'apps/web/src/domain/DomainPage.tsx',
  'apps/web/src/domain/TeamPanel.tsx',
  'apps/web/src/providers/ModelsTab.tsx',
  'apps/web/src/providers/ProvidersPage.tsx',
];

/** Every control in `source` whose body holds a glyph: `line: <the glyph line>`. */
export function glyphControls(source: string): string[] {
  const found: string[] = [];
  const lineOf = (index: number) => source.slice(0, index).split('\n').length;
  // a glyph kept in a constant and rendered by name (`const GEAR = '⚙︎'` … `{GEAR}`)
  const named = [...source.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(['"`])([^'"`\n]*)\2/g)]
    .filter((m) => GLYPH.test(m[3] ?? ''))
    .map((m) => m[1] as string);
  const namedGlyph = named.length === 0 ? undefined : new RegExp(`\\b(${named.join('|')})\\b`);
  const scan = (start: number, end: number) => {
    const body = source.slice(start, end);
    const viaName = namedGlyph?.exec(body);
    // an ellipsis is a glyph when it is the control's whole text: `<button>…</button>`
    const lone = /(?:>|\{['"])\s*…\s*(?:<|['"]\}|$)/.exec(body);
    if (!GLYPH.test(body) && !viaName && lone === null) return;
    const at =
      start + (GLYPH.test(body) ? body.search(GLYPH) : (viaName?.index ?? lone?.index ?? 0));
    const line = lineOf(at);
    found.push(`${line}: ${source.split('\n')[line - 1]?.trim() ?? ''}`);
  };
  for (const { open, close } of CONTROLS) {
    for (const match of source.matchAll(open)) {
      const start = match.index ?? 0;
      const tagEnd = source.indexOf('>', start);
      // a self-closing control has no body
      if (tagEnd > 0 && source[tagEnd - 1] === '/') continue;
      const end = source.indexOf(close, start);
      if (end > 0) scan(start, end);
    }
  }
  // any other element made a button by its role
  for (const match of source.matchAll(/<([A-Za-z][\w.]*)\b[^>]*\brole="button"/g)) {
    const start = match.index ?? 0;
    const end = source.indexOf(`</${match[1]}>`, start);
    if (end > 0) scan(start, end);
  }
  return [...new Set(found)];
}

describe('PG-1.2 no unicode glyph inside a control (D360)', () => {
  it('the scanner finds a glyph in a button, a role=button and a {"…"} expression, and not an ellipsis', () => {
    expect(glyphControls('<button onClick={x}>✕</button>')).toHaveLength(1);
    expect(glyphControls('<div role="button" tabIndex={0}>\n  {"⚙︎"}\n</div>')).toHaveLength(1);
    expect(
      glyphControls('<Button size="sm">\n  <span aria-hidden>▶</span> Run\n</Button>'),
    ).toHaveLength(1);
    expect(
      glyphControls(
        'const GEAR = \'⚙︎\';\n<button aria-label="S">\n  <span>{GEAR}</span>\n</button>',
      ),
    ).toHaveLength(1);
    expect(glyphControls('<button>Connect to…</button>')).toEqual([]);
    expect(glyphControls('<button aria-label="Menu">\n  …\n</button>')).toHaveLength(1);
    expect(glyphControls('<button><Icons.X aria-hidden /></button>')).toEqual([]);
  });

  it('apps/web/src and packages/ui/src have none outside the temporary allow-list', () => {
    const all = sources();
    expect(all.size).toBeGreaterThan(100);
    expect([...all.keys()].some((name) => name.startsWith('packages/ui/src/'))).toBe(true);
    const offenders: string[] = [];
    for (const [name, text] of all) {
      if (TEMPORARY_ALLOW.includes(name)) continue;
      for (const hit of glyphControls(text)) offenders.push(`${name}:${hit}`);
    }
    expect(offenders).toEqual([]);
  });

  it('the allow-list holds only chat/, domain/ and providers/ files that still have a glyph', () => {
    const all = sources();
    for (const name of TEMPORARY_ALLOW) {
      expect(name).toMatch(/^apps\/web\/src\/(chat|domain|providers)\//);
      expect(glyphControls(all.get(name) ?? '').length).toBeGreaterThan(0);
    }
  });
});
