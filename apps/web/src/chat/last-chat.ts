import type { Id, Node } from '@ace/contracts';
import { useEffect, useRef } from 'react';

import { api } from '../app/api';
import { usePanelsStore } from '../app/stores/panels';

/*
 * D372: the chat column reopens on the node the person last chatted with in this workflow, after
 * a refresh or a new tab. The conversations themselves are the engine's (every turn is stored);
 * only which node the column was talking to lived in memory, so a reload opened a blank column.
 */

const KEY = 'ace.lastChatNode';

function readAll(): Record<string, string> {
  try {
    const raw = localStorage.getItem(KEY);
    return raw === null ? {} : (JSON.parse(raw) as Record<string, string>);
  } catch {
    return {};
  }
}

function remember(workflowId: Id, nodeId: Id): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...readAll(), [workflowId]: nodeId }));
  } catch {
    // private mode or blocked storage: the column still works, it just starts blank next time
  }
}

/**
 * Keeps `chatNodeId` across reloads for one workflow: remembers the node the column talks to, and
 * when it talks to none, restores the remembered node — or, with none remembered, the node whose
 * conversation was updated last.
 */
export function useRestoreLastChat(workflowId: Id, chatNodes: readonly Node[]): void {
  const chatNodeId = usePanelsStore((s) => s.chatNodeId);
  const chatWith = usePanelsStore((s) => s.chatWith);
  const tried = useRef<string | undefined>(undefined);
  const ids = chatNodes.map((node) => node.id).join(',');

  useEffect(() => {
    if (chatNodeId !== undefined && chatNodes.some((node) => node.id === chatNodeId)) {
      remember(workflowId, chatNodeId);
    }
  }, [workflowId, chatNodeId, chatNodes]);

  useEffect(() => {
    if (chatNodeId !== undefined || chatNodes.length === 0 || tried.current === workflowId) return;
    tried.current = workflowId;
    const saved = readAll()[workflowId];
    if (saved !== undefined && chatNodes.some((node) => node.id === saved)) {
      chatWith(saved);
      return;
    }
    let cancelled = false;
    void Promise.all(
      chatNodes.map(async (node) => {
        try {
          const threads = await api().listNodeChatThreads(node.id);
          const latest = threads.reduce<string>(
            (max, t) => (t.updatedAt > max ? t.updatedAt : max),
            '',
          );
          return { nodeId: node.id, latest };
        } catch {
          return { nodeId: node.id, latest: '' };
        }
      }),
    ).then((rows) => {
      if (cancelled || usePanelsStore.getState().chatNodeId !== undefined) return;
      const best = rows
        .filter((row) => row.latest !== '')
        .sort((a, b) => (a.latest < b.latest ? 1 : -1))[0];
      if (best !== undefined) chatWith(best.nodeId);
    });
    return () => {
      cancelled = true;
    };
    // `ids` stands for the node list; the array itself changes identity on every render.
  }, [workflowId, chatNodeId, ids, chatWith]);
}
