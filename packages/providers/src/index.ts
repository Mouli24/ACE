/**
 * `@ace/providers` — the model-serving layer (Arch §14): the adapter contract, one adapter per
 * provider type, the model catalog and the router.
 *
 * Nothing here knows about runs, nodes or the database. The engine composes these behind its own
 * ports, which is what lets a hosted deployment swap an adapter without the orchestrator changing.
 */

export * from './adapter.js';
export * from './adapters/ai-sdk.js';
export * from './adapters/mock.js';
export * from './adapters/anthropic.js';
export * from './adapters/google.js';
export * from './adapters/openai.js';
export * from './adapters/openai-compatible.js';
export * from './adapters/ollama.js';
export * from './catalog/index.js';
export * from './router/index.js';
export * from './factory.js';
