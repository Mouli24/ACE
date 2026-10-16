import { useParams } from 'react-router-dom';

import { ChatAside } from '../chat/ChatAside';

/**
 * D367: Domain is the workflow's chat, expanded to the whole screen — the same panel, the same
 * messages, with its node-chat and Run tabs. The Run tab shows the run as its team's conversation
 * (`DomainRunView`, D303), live and with the Team aside.
 */
export function DomainPage() {
  const { workflowId = '' } = useParams();
  return (
    <div data-testid="domain-route" className="flex h-full min-h-0 min-w-0 flex-1">
      <ChatAside workflowId={workflowId} expanded />
    </div>
  );
}
