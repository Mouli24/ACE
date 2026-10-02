/**
 * The user guide, bundled (FR-ONB-003, D240). Every page in `docs/user-guide/*.md` is imported as a
 * string at build time, so `/help/:page` renders with no network call and works offline
 * (NFR-PRIV-01). Adding a page there is enough to publish it here.
 */

const files = import.meta.glob<string>('../../../../docs/user-guide/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** The order the index lists them in; any page not named here follows, alphabetically. */
const ORDER = [
  'getting-started',
  'providers',
  'building-a-workflow',
  'guardrails',
  'knowledge-bases',
  'tools',
  'troubleshooting',
];

export interface GuidePage {
  slug: string;
  title: string;
  markdown: string;
}

function slugOf(path: string): string {
  return path.replace(/^.*\//, '').replace(/\.md$/, '');
}

function titleOf(markdown: string, slug: string): string {
  return /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim() ?? slug;
}

const rank = (slug: string) => {
  const index = ORDER.indexOf(slug);
  return index === -1 ? ORDER.length : index;
};

export const GUIDE_PAGES: readonly GuidePage[] = Object.entries(files)
  .map(([path, markdown]) => {
    const slug = slugOf(path);
    return { slug, title: titleOf(markdown, slug), markdown };
  })
  .sort((a, b) => rank(a.slug) - rank(b.slug) || a.slug.localeCompare(b.slug));

export function guidePage(slug: string | undefined): GuidePage | undefined {
  return GUIDE_PAGES.find((page) => page.slug === slug);
}

/** The slugs every in-app help link may point at — what the link tests check against. */
export const GUIDE_SLUGS: readonly string[] = GUIDE_PAGES.map((page) => page.slug);

const BLOCK_START = /^(#{1,6}\s|```|>|[-*+]\s|\d+[.)]\s|(-{3,}|\*{3,}|_{3,})$)/;

/**
 * Ready a page for `@ace/ui`'s `Markdown`, which keeps a paragraph's line breaks as `<br>` and only
 * links `http(s):` URLs:
 *
 * - hard-wrapped lines are joined back into one paragraph or list item, so the source can stay at
 *   100 columns without the page rendering ragged;
 * - a link to a sibling page (`providers.md`) becomes an absolute `/help/providers` URL on this
 *   origin, which the help page then opens in-app instead of in a new tab.
 */
export function prepareGuideMarkdown(markdown: string, origin: string): string {
  const out: string[] = [];
  let inFence = false;
  let joinable = false;
  for (const raw of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const trimmed = raw.trim();
    if (trimmed.startsWith('```')) {
      inFence = !inFence;
      out.push(raw);
      joinable = false;
      continue;
    }
    if (inFence) {
      out.push(raw);
      continue;
    }
    if (trimmed === '') {
      out.push('');
      joinable = false;
      continue;
    }
    if (BLOCK_START.test(trimmed) && !/^\s/.test(raw)) {
      out.push(raw);
      // A heading or rule stands alone; a list item or quote line can take a continuation.
      joinable = !/^(#{1,6}\s|(-{3,}|\*{3,}|_{3,})$)/.test(trimmed);
      continue;
    }
    if (joinable && out.length > 0) {
      out[out.length - 1] = `${out[out.length - 1]} ${trimmed}`;
      continue;
    }
    out.push(trimmed);
    joinable = true;
  }
  return out
    .join('\n')
    .replace(
      /\]\(([a-z0-9-]+)\.md(#[\w-]+)?\)/g,
      (_match, slug: string, hash: string | undefined) => `](${origin}/help/${slug}${hash ?? ''})`,
    );
}
