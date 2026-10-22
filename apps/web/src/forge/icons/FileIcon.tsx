import { cn } from '@ace/ui';
import { useSyncExternalStore } from 'react';
import theme from 'virtual:material-icons';

import { languageOf } from '../editor/languages';
import { nameOf } from '../files/paths';

type Rules = 'fileExtensions' | 'fileNames' | 'folderNames' | 'folderNamesExpanded' | 'languageIds';

/** A rule's icon, the light theme's variant first (as VS Code reads `light`). */
const rule = (kind: Rules, key: string, light: boolean): string | undefined =>
  (light ? theme.light[kind]?.[key] : undefined) ?? theme[kind][key];

/**
 * The icon VS Code's Material Icon Theme gives a file: its exact name, then its longest compound
 * extension (`d.ts` before `ts`), then its language, then the plain file icon. Names match without
 * case, as VS Code's do.
 */
export function fileIconName(path: string, light = false): string {
  const name = nameOf(path).toLowerCase();
  const byName = rule('fileNames', name, light);
  if (byName !== undefined) return byName;
  for (let dot = name.indexOf('.'); dot !== -1; dot = name.indexOf('.', dot + 1)) {
    const byExtension = rule('fileExtensions', name.slice(dot + 1), light);
    if (byExtension !== undefined) return byExtension;
  }
  return rule('languageIds', languageOf(path), light) ?? theme.file;
}

/** A folder's icon, open or closed: the theme's named folders (`src`, `components`…), else the plain one. */
export function folderIconName(path: string, open: boolean, light = false): string {
  const name = nameOf(path).toLowerCase();
  return (
    rule(open ? 'folderNamesExpanded' : 'folderNames', name, light) ??
    (open ? theme.folderExpanded : theme.folder)
  );
}

export const iconUrl = (icon: string): string =>
  `${import.meta.env.BASE_URL}material-icons/${theme.icons[icon] ?? `${icon}.svg`}`;

/* One observer of the page's theme for every icon on screen, not one per row. */
const listeners = new Set<() => void>();
let observer: MutationObserver | undefined;
const isLight = (): boolean => document.documentElement.dataset['theme'] !== 'dark';
function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  observer ??= new MutationObserver(() => listeners.forEach((listener) => listener()));
  if (listeners.size === 1) {
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
  }
  return () => {
    listeners.delete(onChange);
    if (listeners.size === 0) observer?.disconnect();
  };
}

export interface FileIconProps {
  path: string;
  folder?: boolean;
  /** A folder's open icon. */
  open?: boolean;
  size?: number;
  className?: string;
}

/** A file's or folder's Material Icon Theme icon (decorative: the name beside it says what it is). */
export function FileIcon({
  path,
  folder = false,
  open = false,
  size = 16,
  className,
}: FileIconProps) {
  const light = useSyncExternalStore(subscribe, isLight, () => true);
  const icon = folder ? folderIconName(path, open, light) : fileIconName(path, light);
  return (
    <img
      aria-hidden
      alt=""
      src={iconUrl(icon)}
      width={size}
      height={size}
      draggable={false}
      data-icon={icon}
      className={cn('shrink-0 select-none', className)}
    />
  );
}
