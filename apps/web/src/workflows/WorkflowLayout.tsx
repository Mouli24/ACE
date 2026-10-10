import { Link, Outlet, useNavigate, useParams } from 'react-router-dom';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';

import { RESIZE_HANDLE_X } from '../app/layout/resize-handle';
import { SHORTCUTS, useShortcuts } from '../app/shortcuts';
import { useWorkflowSubscription } from '../app/socket';
import { useLayoutStore } from '../app/stores/layout';
import { ChatAside } from '../chat';
import { workflowPath } from '../forge/mode';
import { useIsCompact } from '../responsive/useIsCompact';
import { useAdoptActiveRun, useRunEvents } from '../runs/hooks';
import { useWorkflowGraph } from './hooks';

/**
 * The parent of both modes (D299, design §2.1). It owns what must outlive a switch: the workflow
 * subscription, the run events and adopting an active run (all three used to live in
 * WorkflowPage), and the chat column — so switching Ideate ⇄ Forge changes the main area only and
 * a reply still arriving keeps arriving. At phone width the modes lay themselves out and there is
 * no chat column here (Ideate's compact layout has its own chat tab).
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
    [SHORTCUTS.toggleChat, toggleChat],
  ]);

  if (graph.isError) {
    return (
      <p role="alert" className="p-6 text-danger">
        Workflow not found.{' '}
        <Link to={`/projects/${projectId}`} className="underline">
          Back to the project
        </Link>
      </p>
    );
  }
  if (compact) return <Outlet />;

  return (
    <PanelGroup direction="horizontal" autoSaveId="ace.workflow" className="h-full">
      <Panel id="workflow-main" order={1} minSize={40} className="min-h-0 min-w-0">
        <Outlet />
      </Panel>
      {chatOpen && (
        <>
          <PanelResizeHandle className={RESIZE_HANDLE_X} />
          <Panel
            id="workflow-chat"
            order={2}
            defaultSize={24}
            minSize={16}
            maxSize={45}
            className="min-h-0 min-w-0"
          >
            {/* a plain box: ChatAside is the landmark (<aside aria-label="Chat">) and draws the rule */}
            <div data-testid="chat-column" className="flex h-full min-h-0 min-w-0 flex-col">
              <ChatAside workflowId={workflowId} />
            </div>
          </Panel>
        </>
      )}
    </PanelGroup>
  );
}
