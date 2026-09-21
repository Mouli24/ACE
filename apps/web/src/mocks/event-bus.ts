import type { MockEvent } from './db';

/**
 * Fan-out for mock engine events: listeners in this tab, plus a BroadcastChannel so a second tab
 * (TC-WF-005) hears `workflow.updated` the way it would from the real engine.
 */
const CHANNEL = 'ace.mock.events';

type Listener = (event: MockEvent) => void;

const listeners = new Set<Listener>();
let channel: BroadcastChannel | undefined;

function getChannel(): BroadcastChannel | undefined {
  if (channel) return channel;
  if (typeof BroadcastChannel === 'undefined') return undefined;
  channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = (message: MessageEvent<MockEvent>) => {
    for (const listener of listeners) listener(message.data);
  };
  return channel;
}

export function publishMockEvent(event: MockEvent): void {
  for (const listener of listeners) listener(event);
  getChannel()?.postMessage(event);
}

export function subscribeMockEvents(listener: Listener): () => void {
  getChannel();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
