import { useLayoutStore } from '../app/stores/layout';
import { usePanelsStore } from '../app/stores/panels';
import { useSelectionStore } from '../app/stores/selection';
import { useChatSessions } from './session-store';

/**
 * PG-3.6: open the chat column on one node's direct chat thread — from Domain's node lens, which
 * lists those threads read-only. The node becomes the chat's target and the selected node, the
 * thread the one on screen, and the column is opened if it was closed. Navigating to a mode with
 * the column (Ideate or Forge) is the caller's.
 */
export function openChatThread(nodeId: string, threadId: string): void {
  useChatSessions.getState().update(nodeId, (session) => {
    const { fresh: _fresh, ...rest } = session;
    return { ...rest, threadId };
  });
  usePanelsStore.getState().chatWith(nodeId);
  useSelectionStore.getState().setSelection([nodeId], []);
  if (!useLayoutStore.getState().chatOpen) useLayoutStore.getState().toggleChat();
}
