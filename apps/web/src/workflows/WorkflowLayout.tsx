import { useEffect } from 'react';
import { Link, Outlet, useNavigate, useParams, useSearchParams } from 'react-router-dom';

import { useNodeFocusSync } from '../app/follow-node';
import { SHORTCUTS, useShortcuts } from '../app/shortcuts';
import { useWorkflowSubscription } from '../app/socket';
import { useLayoutStore } from '../app/stores/layout';
import { usePanelsStore } from '../app/stores/panels';
import { useSelectionStore } from '../app/stores/selection';
import { ChatAside } from '../chat';
import { useComposerChips } from '../chat/composer-chips';
import { useChatSocket } from '../chat/useChat';
import { isChatNode, useDropStaleChatTarget } from '../chat/workflow-target';
import { useWorkflowMode, workflowPath } from '../forge/mode';
import { useIsCompact } from '../responsive/useIsCompact';
import { useRunEvents } from '../runs/hooks';
import { useAdoptActiveRun, useFollowStartedRun } from '../runs/selected-run';
import { useWorkflowGraph } from './hooks';

/**
 * The parent of Ideate, Forge and Domain (D299, D354). It owns what must outlive a switch: the
 * workflow subscription, the run events, adopting the selected run (PG-3.2) and the chat socket —
 * each mounted once, here, for all three modes — and the chat column, so switching modes changes
 * the main area only and a reply still arriving keeps arriving.
 *
 * The chat column is the theme's fixed aside beside the main area (D330), shown in Ideate and Forge
 * while Chat is on; Domain keeps its full-screen look with its own Team aside (D354, D356). At
 * phone width the modes lay themselves out and there is no chat column here (Ideate's compact
 * layout has its own chat tab). It also keeps the chat's target and the composer's chips to this
 * workflow and project, with the column open or not (fix F-I2, B-M7).
 */
export function WorkflowLayout() {
  const { projectId = '', workflowId = '' } = useParams();
  const [search] = useSearchParams();
  const mode = useWorkflowMode();
  const graph = useWorkflowGraph(workflowId);
  const compact = useIsCompact();
  useWorkflowSubscription(workflowId);
  useRunEvents(workflowId);
  // PG-3.2: coming back to a mode re-adopts the selected run, finished or live.
  useAdoptActiveRun(workflowId, mode);
  useFollowStartedRun(workflowId);
  // PG-3.4: `?node=` and the selected node are one, in every mode.
  useNodeFocusSync(mode);
  useDropStaleChatTarget(workflowId);
  useEffect(() => {
    useComposerChips.getState().enterProject(projectId);
  }, [projectId]);

  // One socket link for every chat session, in every mode (D354): the column's node, or the phone
  // layout's focused node, is the one whose thread is watched besides any reply still owed.
  const chatNodeId = usePanelsStore((s) => s.chatNodeId);
  const focusedNodeId = useSelectionStore((s) => s.focusedNodeId);
  const activeChatId = compact ? focusedNodeId : chatNodeId;
  const chatTarget = graph.data?.nodes.find((node) => node.id === activeChatId && isChatNode(node));
  useChatSocket(chatTarget?.id);

  const chatOpen = useLayoutStore((s) => s.chatOpen);
  const toggleChat = useLayoutStore((s) => s.toggleChat);
  const toggleTeam = useLayoutStore((s) => s.toggleTeam);
  const navigate = useNavigate();
  useShortcuts([
    [SHORTCUTS.ideate, () => navigate(workflowPath(projectId, workflowId, 'ideate', search))],
    [SHORTCUTS.forge, () => navigate(workflowPath(projectId, workflowId, 'forge', search))],
    [SHORTCUTS.domain, () => navigate(workflowPath(projectId, workflowId, 'domain', search))],
    // D356: Chat in Ideate and Forge, Team in Domain — each its own.
    [SHORTCUTS.toggleChat, mode === 'domain' ? toggleTeam : toggleChat],
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
      {chatOpen && mode !== 'domain' && (
        // a plain box: ChatAside is the landmark (<aside aria-label="Chat">) and draws its width and rule
        <div data-testid="chat-column" className="flex min-h-0 shrink-0">
          <ChatAside workflowId={workflowId} />
        </div>
      )}
    </div>
  );
}
