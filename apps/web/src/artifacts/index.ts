/**
 * The uploads/attachments toolkit (M4 area C). Area E (chat) imports the reusable pieces from here:
 * `useArtifactUpload` and `AttachmentPicker` for the composer, `AttachmentList`/`useArtifact` to show
 * what is attached, and `uploadErrorMessage` for a consistent 413/415 message.
 */
export { useArtifactUpload } from './useArtifactUpload';
export type { ArtifactUploadState, UseArtifactUpload } from './useArtifactUpload';
export { AttachmentPicker } from './AttachmentPicker';
export type { AttachmentPickerProps } from './AttachmentPicker';
export { AttachmentList } from './AttachmentList';
export type { AttachmentListProps } from './AttachmentList';
export { InputDropZone } from './InputDropZone';
export type { InputDropZoneProps } from './InputDropZone';
export { useInputArtifacts } from './useInputArtifacts';
export type { UseInputArtifacts } from './useInputArtifacts';
export { useArtifact, artifactQueryKey } from './useArtifact';
export { uploadErrorMessage } from './upload-error';
