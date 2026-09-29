import type { InputConfig } from '@ace/contracts';

import { AttachmentList } from '../artifacts/AttachmentList';
import { AttachmentPicker } from '../artifacts/AttachmentPicker';
import { useInputArtifacts } from '../artifacts/useInputArtifacts';

export interface InputAttachmentsProps {
  workflowId: string;
  nodeId: string;
  config: InputConfig;
}

/**
 * The Input node's attachments section for the config panel (M4 §2 item 1, FR-MM-007). A file picker
 * with drag-and-drop uploads an artifact; its id is stored on the node's `artifactIds`, and the list
 * below shows each attachment with its size, type, download and remove. Upload errors (413/415) are
 * shown inline by the picker (FR-MM-001, NFR-USE-03).
 *
 * Standalone by design so it can be dropped into `InputPanel` without reshaping the panels file — see
 * the M4 report for exactly where it is wired.
 */
export function InputAttachments({ workflowId, nodeId, config }: InputAttachmentsProps) {
  const { artifactIds, add, remove } = useInputArtifacts(workflowId, nodeId, config);

  return (
    <section className="flex flex-col gap-2" data-testid="input-attachments">
      <h3 className="font-machine text-[10px] uppercase tracking-wider text-fg-muted">Files</h3>
      <AttachmentPicker
        label="Attach files to this input"
        onUploaded={(artifact) => add(artifact.id)}
        data-testid="input-attachment-picker"
      />
      <AttachmentList artifactIds={artifactIds} onRemove={remove} data-testid="input-attachment-list" />
    </section>
  );
}
