/** TanStack Query keys for direct-chat data (FR-CHAT-004). Kept beside the panel that owns it. */
export const chatKeys = {
  /** Every thread of one agent node — what a new/deleted thread invalidates. */
  threads: (nodeId: string) => ['chat-threads', nodeId] as const,
  /** One thread's settled turns — what an agent reply settling invalidates (FR-CHAT-006). */
  thread: (threadId: string) => ['chat-thread', threadId] as const,
};
