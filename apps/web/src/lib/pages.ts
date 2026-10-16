/** Every page of a cursor list (§2.8): follows `nextCursor` until the engine says there is no more. */
export async function allPages<T>(
  load: (cursor: string | undefined) => Promise<{ items: T[]; nextCursor?: string }>,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await load(cursor);
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return items;
}
