/** Forge's wire paths (D299): project-relative, forward slashes, `''` is the root. */

export const parentOf = (path: string): string =>
  path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';

export const nameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

export const joinPath = (folder: string, name: string): string =>
  folder === '' ? name : `${folder}/${name}`;

/** `path` is `prefix` itself or lies inside it. */
export const isWithin = (path: string, prefix: string): boolean =>
  prefix === '' || path === prefix || path.startsWith(`${prefix}/`);

/** Where `path` lands when `from` (it, or a folder holding it) moves to `to`. */
export const movedPath = (path: string, from: string, to: string): string =>
  path === from ? to : `${to}${path.slice(from.length)}`;

export const extensionOf = (path: string): string => {
  const name = nameOf(path);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
};

const IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'ico',
  'bmp',
  'avif',
]);

export const isImagePath = (path: string): boolean => IMAGE_EXTENSIONS.has(extensionOf(path));
