import { base } from '@ace/config/eslint.config.js';

// The acceptance suite is the one place that drives the real engine over HTTP and WebSocket, so it
// is allowed both Node APIs and the workspace packages; the layering rules that keep engine and web
// apart do not apply to a black-box test of the two together.
export default base;
