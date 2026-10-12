const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * Why a name cannot be used, in words — the engine's rule (`assertValidName`, §6.1), checked
 * before the request so the person sees it while typing. A create may hold slashes (`a/b.ts`
 * makes the folder too); a rename may not.
 */
export function nameProblem(
  name: string,
  siblings: readonly string[],
  options: { allowSlash: boolean },
): string | undefined {
  if (name.trim() === '') return 'A name is required.';
  if (!options.allowSlash && /[\\/]/.test(name)) return 'A name cannot contain a slash.';
  const segments = options.allowSlash ? name.split('/') : [name];
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return 'That name is reserved.';
    if (/[<>:"|?*\\]/.test(segment)) return 'A name cannot contain < > : " | ? *';
    if (/[. ]$/.test(segment)) return 'A name cannot end with a dot or a space.';
    if (RESERVED.test(segment)) return 'Windows reserves that name.';
  }
  // a multi-segment create goes through (or makes) folders; the engine judges what exists there
  if (segments.length !== 1) return undefined;
  const first = segments[0] ?? name;
  if (siblings.some((sibling) => sibling.toLowerCase() === first.toLowerCase()))
    return `“${first}” already exists here.`;
  return undefined;
}
