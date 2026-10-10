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
