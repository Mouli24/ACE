import { Link, Outlet, useNavigate, useParams } from 'react-router-dom';

import { SHORTCUTS, useShortcuts } from '../app/shortcuts';
import { useWorkflowSubscription } from '../app/socket';
import { useLayoutStore } from '../app/stores/layout';
import { ChatAside } from '../chat';
import { workflowPath } from '../forge/mode';
import { useIsCompact } from '../responsive/useIsCompact';
import { useAdoptActiveRun, useRunEvents } from '../runs/hooks';
import { useWorkflowGraph } from './hooks';

/**
 * The parent of Ideate and Forge (D299, design §2.1). It owns what must outlive a switch: the
 * workflow subscription, the run events and adopting an active run, and the chat column — so
 * switching Ideate ⇄ Forge changes the main area only and a reply still arriving keeps arriving.
 * The chat column is the theme's fixed aside beside the main area (D330), shown while Split is on.
 * At phone width the modes lay themselves out and there is no chat column here (Ideate's compact
 * layout has its own chat tab).
 */
export function WorkflowLayout() {
  const { projectId = '', workflowId = '' } = useParams();
  const graph = useWorkflowGraph(workflowId);
  useWorkflowSubscription(workflowId);
  useRunEvents(workflowId);
  useAdoptActiveRun(workflowId);
  const compact = useIsCompact();
  const chatOpen = useLayoutStore((s) => s.chatOpen);
  const toggleChat = useLayoutStore((s) => s.toggleChat);
  const navigate = useNavigate();
  useShortcuts([
    [SHORTCUTS.ideate, () => navigate(workflowPath(projectId, workflowId, 'ideate'))],
    [SHORTCUTS.forge, () => navigate(workflowPath(projectId, workflowId, 'forge'))],
    [SHORTCUTS.domain, () => navigate(workflowPath(projectId, workflowId, 'domain'))],
    [SHORTCUTS.toggleChat, toggleChat],
  ]);

  if (graph.isError) {
    return (
      <p role="alert" className="p-6 text-[13px] text-[#c94c27]">
        Workflow not found.{' '}
        <Link to={`/projects/${projectId}`} className="underline">
          Back to the project
        </Link>
      </p>
    );
  }
  if (compact) return <Outlet />;

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      {/* the mode's screen fills the main area, whatever its own root says */}
      <div className="flex min-h-0 min-w-0 flex-1 *:min-w-0 *:flex-1">
        <Outlet />
      </div>
      {chatOpen && (
        // a plain box: ChatAside is the landmark (<aside aria-label="Chat">) and draws its width and rule
        <div data-testid="chat-column" className="flex min-h-0 shrink-0">
          <ChatAside workflowId={workflowId} />
        </div>
      )}
    </div>
  );
}
