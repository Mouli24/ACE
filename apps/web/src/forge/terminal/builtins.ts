/**
 * What a terminal tab does itself rather than hand to a shell (D301, design §6.3): `cd`, so the
 * folder persists between commands, and `cls` / `clear`. Other shell state does not carry over
 * (design §14); a `cd` chained with `&&`, `|`, `;`, `<` or `>` runs in the shell, where it lasts
 * only for that line.
 */

export type Builtin = { kind: 'cd'; arg: string | undefined } | { kind: 'clear' };

const SHELL_SYNTAX = /[&|;<>]/;

const unquote = (text: string): string => (/^(["']).*\1$/.test(text) ? text.slice(1, -1) : text);

export function parseBuiltin(line: string): Builtin | undefined {
  const trimmed = line.trim();
  if (/^(cls|clear)$/i.test(trimmed)) return { kind: 'clear' };
  const cd = /^cd(?:(\.\.?)|\s+(.*))?$/i.exec(trimmed);
  if (cd === null) return undefined;
  const raw = (cd[1] ?? cd[2] ?? '').trim();
  if (SHELL_SYNTAX.test(raw)) return undefined;
  return { kind: 'cd', arg: raw === '' ? undefined : unquote(raw) };
}

/**
 * Where `cd <arg>` leads from `cwd`, project-relative. `/` and `~` are the project root, `..` at the
 * root stays there. The files API then confines the result exactly as the engine confines a
 * process's folder, and refuses one that is outside or missing.
 */
export function resolveCd(cwd: string, arg: string): string {
  const path = arg.split('\\').join('/');
  const fromRoot = path.startsWith('/') || path === '~' || path.startsWith('~/');
  const parts = fromRoot ? [] : cwd.split('/').filter((segment) => segment !== '');
  for (const segment of path.replace(/^~/, '').split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') parts.pop();
    else parts.push(segment);
  }
  return parts.join('/');
}
