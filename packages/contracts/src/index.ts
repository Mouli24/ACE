/**
 * `@ace/contracts` — the one seam between the engine and the web app (CLAUDE.md §3.4 rule 2).
 *
 * Everything here is round 1 §2 of docs/team-prompts/01-round-1-skeleton.md, implemented verbatim.
 * The barrel also re-exports an empty placeholder module per later round, so that adding round 2's
 * contract never changes this file (round 1 §3 item 3).
 */

/* Round 1 — §2.2 to §2.9 */
export * from './enums.js';
export * from './errors.js';
export * from './graph.js';
export * from './validation.js';
export * from './graph-ops.js';
export * from './settings.js';
export * from './export.js';
export * from './api.js';
export * from './ws.js';

/* Round 2 */
export * from './providers.js';
export * from './models.js';
export * from './runs.js';
export * from './envelope.js';
export * from './events.js';

/* Round 3 */
export * from './guardrails.js';

/* Round 4 */
export * from './tools.js';
export * from './artifacts.js';
export * from './chat.js';

/* Round 5 */
export * from './knowledge.js';
export * from './memory.js';
export * from './usage.js';
export * from './templates.js';

/* Domain (D303–D327) */
export * from './domain.js';
