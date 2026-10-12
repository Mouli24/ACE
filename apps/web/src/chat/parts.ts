import type { Artifact, Part } from '@ace/contracts';

/**
 * Turn an uploaded artifact into the `Part` reference a chat message carries (FR-CHAT-007, BR-02).
 * A file travels as a reference and never as bytes, so the type is decided from the MIME the engine
 * recorded, and the artifact id, name and size ride along for the renderers.
 */
export function partForArtifact(artifact: Artifact): Part {
  const type: 'image' | 'audio' | 'video' | 'file' = artifact.mime.startsWith('image/')
    ? 'image'
    : artifact.mime.startsWith('audio/')
      ? 'audio'
      : artifact.mime.startsWith('video/')
        ? 'video'
        : 'file';
  return {
    type,
    artifactId: artifact.id,
    mime: artifact.mime,
    name: artifact.name,
    size: artifact.size,
  };
}
