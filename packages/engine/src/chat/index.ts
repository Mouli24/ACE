/**
 * The chat service (FR-CHAT-001..008, round 4 §2.3, Arch §12.2): the workflow timeline and direct
 * agent threads. `createChatService` is the HTTP surface's engine; `startTimelinePopulation` wires
 * the timeline to the event bus.
 */
export * from './errors.js';
export * from './guardrails.js';
export * from './prompt.js';
export * from './timeline.js';
export * from './service.js';
