import type { ArtifactRef } from '@ace/contracts';

import { api } from '../app/api';

/**
 * D307: the one place an artifact ref opens from. Today that is the artifact's content view;
 * once checkpoints exist it becomes the Code surface's file at `ref.commit`. A ref with no stored
 * artifact behind it (a path the CLI touched) has nowhere to open yet.
 */
export function openArtifactHref(ref: ArtifactRef): string | undefined {
  return ref.artifactId === undefined ? undefined : api().artifactContentUrl(ref.artifactId);
}

const ABSOLUTE = /^(?:\/|[a-z]:\/)/iu;
const DRIVE = /^[a-z]:\//iu;

/**
 * A ref's path relative to the project folder — Forge's wire form, forward slashes — or undefined
 * when it lies outside. A relative path is the project's already; an absolute one is the project's
 * when it sits under `folderPath` (case-insensitively on a Windows drive).
 */
export function projectRelativePath(
  path: string,
  folderPath: string | undefined,
): string | undefined {
  const normal = path.replace(/\\/gu, '/');
  let relative: string;
  if (ABSOLUTE.test(normal)) {
    if (folderPath === undefined || folderPath.trim() === '') return undefined;
    const root = folderPath.replace(/\\/gu, '/').replace(/\/+$/u, '');
    const fold = DRIVE.test(root);
    const under = fold
      ? normal.toLowerCase().startsWith(`${root.toLowerCase()}/`)
      : normal.startsWith(`${root}/`);
    if (!under) return undefined;
    relative = normal.slice(root.length + 1);
  } else {
    relative = normal.replace(/^(?:\.\/)+/u, '');
  }
  const segments = relative.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.length === 0 || segments.includes('..')) return undefined;
  return segments.join('/');
}

/**
 * Where an output card's "Open →" goes (D336): the file in Forge when it is the project's (and
 * Forge can be reached), else the D307 content view; undefined when it has nowhere to open.
 */
export type ArtifactTarget = { kind: 'forge'; path: string } | { kind: 'href'; href: string };

export function artifactTarget(
  ref: ArtifactRef,
  folderPath: string | undefined,
  forge = true,
): ArtifactTarget | undefined {
  const path = forge ? projectRelativePath(ref.path, folderPath) : undefined;
  if (path !== undefined) return { kind: 'forge', path };
  const href = openArtifactHref(ref);
  return href === undefined ? undefined : { kind: 'href', href };
}
