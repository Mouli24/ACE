import type { InputConfig } from '@ace/contracts';
import { FIELD_LABEL_CLASS } from '@ace/ui';

import { AttachmentList } from '../artifacts/AttachmentList';
import { AttachmentPicker } from '../artifacts/AttachmentPicker';
import { useInputArtifacts } from '../artifacts/useInputArtifacts';

export interface InputAttachmentsProps {
  workflowId: string;
  nodeId: string;
  config: InputConfig;
}

/**
 * The Input node's attachments in the node settings modal (M4 §2 item 1, FR-MM-007). A file picker
 * with drag-and-drop uploads an artifact; its id is stored on the node's `artifactIds`, and the list
 * below shows each attachment with its size, type, download and remove. Upload errors (413/415) are
 * shown inline by the picker (FR-MM-001, NFR-USE-03).
 */
export function InputAttachments({ workflowId, nodeId, config }: InputAttachmentsProps) {
  const { artifactIds, add, remove } = useInputArtifacts(workflowId, nodeId, config);

  return (
    <section className="flex min-w-0 flex-col gap-[7px]" data-testid="input-attachments">
      <h3 className={FIELD_LABEL_CLASS}>Files</h3>
      <AttachmentPicker
        label="Attach files to this input"
        onUploaded={(artifact) => add(artifact.id)}
        data-testid="input-attachment-picker"
      />
      <AttachmentList
        artifactIds={artifactIds}
        onRemove={remove}
        data-testid="input-attachment-list"
      />
    </section>
  );
}
