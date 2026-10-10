/**
 * Domain (D303–D327): the team-chat view of a run, projected from its event log on the server.
 */
export {
  LOOP_COUNTED_KINDS,
  countLoop,
  digestLine,
  pairKey,
  routeEnvelope,
  type BrainRoute,
  type BrainRouteInput,
} from './brain.js';
export { domainContextFor, labelOf, type DomainContext } from './context.js';
export {
  envelopeBody,
  extractEnvelopeBlocks,
  judgeEnvelopeBlocks,
  type EnvelopeJudgement,
  type JudgeContext,
  type JudgedEnvelope,
  type OpenQuery,
} from './envelope-block.js';
export { costOfTurn, findPrice, sumCosts } from './pricing.js';
export {
  artifactRefs,
  autoExcerpt,
  createDomainProjection,
  type ChatOp,
  type DomainProjection,
  type TurnUsage,
} from './projection.js';
export { filterForNode, projectChat } from './project-chat.js';
export { projectUsage, usageSnapshot } from './project-usage.js';
export {
  TURN_NOW_STATES,
  createRunDomain,
  isTurnAbortReason,
  type EnvelopeDecision,
  type HeldEnvelope,
  type QueuedEnvelope,
  type QueuedMessage,
  type RunDomain,
  type TurnAbortReason,
} from './run-domain.js';
export { createDomainRegistry, type DomainRegistry } from './registry.js';
export { createDomainService, type DomainService } from './service.js';
export { createDomainRoutes } from './routes.js';
