import type { Node } from '@ace/contracts';
import { ArrowUp } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';

import { usePanelsStore } from '../app/stores/panels';
import { useProviders } from '../providers/hooks';
import { useWorkflowGraph } from '../workflows/hooks';
import { ChatConversation } from './ChatConversation';
import { ChatThreadList } from './ChatThreadList';
import { useChatThreads, useThreadConversation } from './useChat';

const isChatNode = (node: Node): boolean => node.kind === 'agent' || node.kind === 'model';

/** The provider dot: a CSS variable so Night and Paper each use their own colour. */
function Dot({ providerType }: { providerType: string | undefined }) {
  return (
    <span
      aria-hidden
      className="h-[7px] w-[7px] shrink-0 rounded-full"
      style={{ background: `var(--color-provider-${providerType ?? 'mock'})` }}
    />
  );
}

/**
 * The permanent 340 px Chat column (FR-CHAT-004..008). Pick an Agent or Model node with an @mention
 * chip (or by typing `@` in the composer) and talk to it directly; the conversation reuses the
 * thread list and `ChatConversation`, which never read or write runs (FR-CHAT-005). The compact
 * layout keeps `ChatPanel` (FR-MOB-003).
 */
export function ChatAside({ workflowId }: { workflowId: string }) {
  const chatNodeId = usePanelsStore((s) => s.chatNodeId);
  const chatWith = usePanelsStore((s) => s.chatWith);
  const graph = useWorkflowGraph(workflowId);
  const providers = useProviders();

  const nodes = graph.data?.nodes;
  const chatNodes = (nodes ?? []).filter(isChatNode);
  const target = chatNodes.find((each) => each.id === chatNodeId);
  const providerType = (node: Node) => {
    const providerId = 'providerId' in node.config ? node.config.providerId : undefined;
    return providers.data?.find((each) => each.id === providerId)?.type;
  };

  // The target left the graph (or cannot chat): back to the intro state.
  useEffect(() => {
    if (nodes !== undefined && chatNodeId !== undefined && target === undefined) chatWith(undefined);
  }, [nodes, chatNodeId, target, chatWith]);

  const chips = (
    <div className="flex flex-wrap gap-[5px]" data-testid="chat-mentions">
      {chatNodes.map((node) => (
        <button
          key={node.id}
          type="button"
          data-testid={`chat-mention-${node.id}`}
          aria-pressed={node.id === chatNodeId}
          onClick={() => chatWith(node.id)}
          className={`inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full border px-[9px] font-machine text-[10.5px] hover:border-border-strong hover:text-fg ${
            node.id === chatNodeId ? 'border-border-strong text-fg' : 'border-border text-fg-soft'
          }`}
        >
          <Dot providerType={providerType(node)} />@{node.name}
        </button>
      ))}
    </div>
  );

  return (
    <aside
      aria-label="Chat"
      data-testid="chat-aside"
      className="flex h-full min-h-0 min-w-0 flex-col border-l border-border bg-panel"
    >
      <div className="flex items-baseline justify-between gap-2.5 border-b border-border px-[18px] pb-3 pt-4">
        <h2 className="text-[19px] font-semibold">Chat</h2>
        <span className="min-w-0 truncate font-machine text-[9.5px] tracking-[0.06em] text-fg-faint">
          @ a node to talk to it
        </span>
      </div>

      {target === undefined ? (
        <>
          <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-[18px] py-4">
            <div className="max-w-[92%] self-start rounded-[14px_14px_14px_4px] border border-border bg-canvas px-[13px] py-[9px] text-[14.5px] text-fg-soft">
              Mention any Agent or Model node to talk to it directly.
            </div>
          </div>
          <MentionComposer
            nodes={chatNodes}
            providerType={providerType}
            onPick={chatWith}
            chips={chips}
          />
        </>
      ) : (
        // Keyed by node id so switching nodes starts each agent's chat clean.
        <TargetChat key={target.id} node={target} chips={chips} />
      )}
    </aside>
  );
}

function TargetChat({ node, chips }: { node: Node; chips: ReactNode }) {
  const [activeThreadId, setActiveThreadId] = useState<string | undefined>();
  const threads = useChatThreads(node.id);
  const convo = useThreadConversation(node.id, activeThreadId, setActiveThreadId);
  return (
    <>
      <ChatThreadList
        nodeId={node.id}
        threads={threads.data ?? []}
        activeThreadId={activeThreadId}
        onSelect={setActiveThreadId}
        onNew={() => setActiveThreadId(undefined)}
        onDeleted={(threadId) => {
          if (threadId === activeThreadId) setActiveThreadId(undefined);
        }}
      />
      <ChatConversation node={node} convo={convo} aboveComposer={chips} />
    </>
  );
}

/** The no-target footer: chips plus an input where `@` + letters opens the node picker. */
function MentionComposer({
  nodes,
  providerType,
  onPick,
  chips,
}: {
  nodes: Node[];
  providerType: (node: Node) => string | undefined;
  onPick: (nodeId: string) => void;
  chips: ReactNode;
}) {
  const [text, setText] = useState('');
  const [cursor, setCursor] = useState(0);

  const query = /(?:^|\s)@(\S*)$/.exec(text)?.[1]?.toLowerCase();
  const matches =
    query === undefined ? [] : nodes.filter((node) => node.name.toLowerCase().includes(query));
  const open = matches.length > 0;
  const active = Math.min(cursor, Math.max(matches.length - 1, 0));

  const pick = (node: Node) => {
    onPick(node.id);
    setText('');
    setCursor(0);
  };

  return (
    <div className="relative flex flex-col gap-2 border-t border-border px-3.5 pb-3.5 pt-3">
      {open && (
        <div
          role="listbox"
          aria-label="Nodes"
          data-testid="chat-mention-picker"
          className="absolute bottom-[calc(100%-4px)] left-3.5 right-3.5 flex flex-col rounded-xl border border-border-strong bg-panel p-1 shadow-lg"
        >
          <span className="px-2.5 pb-1 pt-1.5 font-machine text-[9px] uppercase tracking-[0.2em] text-fg-faint">
            Nodes
          </span>
          {matches.map((node, index) => (
            <button
              key={node.id}
              type="button"
              role="option"
              aria-selected={index === active}
              data-testid={`chat-mention-option-${node.id}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => pick(node)}
              className={`flex h-[34px] items-center gap-[9px] rounded-lg px-2.5 text-left hover:bg-card ${
                index === active ? 'bg-card' : ''
              }`}
            >
              <Dot providerType={providerType(node)} />
              <span className="text-[14.5px]">{node.name}</span>
              <span className="ml-auto font-machine text-[10px] text-fg-faint">{node.kind}</span>
            </button>
          ))}
        </div>
      )}
      {chips}
      <div className="flex items-end gap-2 rounded-[14px] border border-border bg-card py-1.5 pl-3 pr-1.5 focus-within:ring-2 focus-within:ring-accent">
        <textarea
          rows={2}
          value={text}
          placeholder="Message a node — type @ to pick one"
          aria-label="Message a node"
          data-testid="chat-aside-input"
          onChange={(event) => {
            setText(event.target.value);
            setCursor(0);
          }}
          onKeyDown={(event) => {
            if (!open) return;
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setCursor((active + 1) % matches.length);
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setCursor((active - 1 + matches.length) % matches.length);
            } else if (event.key === 'Enter' || event.key === 'Tab') {
              event.preventDefault();
              const chosen = matches[active];
              if (chosen !== undefined) pick(chosen);
            } else if (event.key === 'Escape') {
              setText('');
            }
          }}
          className="flex-1 resize-none border-0 bg-transparent px-0 py-1 font-human text-[14.5px] leading-[1.45] text-fg placeholder:text-fg-faint focus-visible:outline-none"
        />
        <button
          type="button"
          aria-label="Pick a node"
          title="Send"
          disabled={!open}
          onClick={() => {
            const chosen = matches[active];
            if (chosen !== undefined) pick(chosen);
          }}
          className="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-full bg-accent text-accent-fg disabled:opacity-40"
        >
          <ArrowUp className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>
    </div>
  );
}
