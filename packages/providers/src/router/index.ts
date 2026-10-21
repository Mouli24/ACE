import type { ErrorKind, Id } from '@ace/contracts';

import type {
  AttemptState,
  ModelRouter,
  RouteRefusalCode,
  RouteResult,
  RouterModel,
  RoutingNodeConfig,
  RoutingRequirements,
} from '@ace/engine';

/**
 * The model router (FR-RTR-001..007, Arch §14.3).
 *
 * Pure selection over the catalog: it reads rows, it never calls a provider, and the same inputs
 * always give the same route. Which model actually answered is recorded on the node run
 * (FR-RTR-006), and a fallback is flagged so the Canvas can say so.
 *
 * The interface lives in `@ace/engine`'s ports (CLAUDE.md §3.4 rule 3) and is re-exported here.
 */

export {
  ROUTE_REFUSAL_CODES,
  type AttemptState,
  type ModelRouter,
  type Route,
  type RouteRefusalCode,
  type RouteResult,
  type RouterModel,
  type RoutingNodeConfig,
  type RoutingRequirements,
} from '@ace/engine';

/** The router as this package builds it. */
export type Router = ModelRouter;

/**
 * Error kinds a different model could plausibly survive (FR-RTR-002).
 *
 * Everything else stops the chain: a bad key, a malformed request or a model that refused are all
 * things the next model would hit too, and walking the chain would just spend money confirming it.
 */
const FALLBACK_KINDS: ReadonlySet<ErrorKind> = new Set<ErrorKind>(['provider', 'network']);

function covers(model: RouterModel, requirements: RoutingRequirements): boolean {
  return (
    requirements.inputTypes.every((type) => model.inputTypes.includes(type)) &&
    requirements.outputTypes.every((type) => model.outputTypes.includes(type))
  );
}

/** The catalog, read lazily so the router always sees the current rows. */
export type CatalogReader = () => readonly RouterModel[];

export function createRouter(catalog: CatalogReader): Router {
  /**
   * Find the row for a model id, preferring the provider the node names — a fallback entry is a
   * bare model id (§2.4), so the same id offered by two providers has to resolve somehow.
   *
   * [audit P-15] The node's own model is looked up on its own provider only (`ownOnly`): a row
   * missing there must refuse, not quietly run the call on another provider — another key, another
   * bill — that happens to list the same id.
   */
  function find(modelId: string, providerId: Id, ownOnly: boolean): RouterModel | undefined {
    const rows = catalog().filter((row) => row.modelId === modelId);
    const own = rows.find((row) => row.providerId === providerId);
    return own ?? (ownOnly ? undefined : rows[0]);
  }

  function checkCandidate(
    model: RouterModel | undefined,
    modelId: string,
    requirements: RoutingRequirements,
  ): RouteRefusalCode | undefined {
    if (model === undefined || !model.available) return 'unavailable_model';
    if (!covers(model, requirements)) return 'incompatible_model';
    return undefined;
  }

  function resolve(
    node: RoutingNodeConfig,
    requirements: RoutingRequirements,
    attemptState: AttemptState,
  ): RouteResult {
    const { policy } = node.routing;

    if (policy !== 'fixed' && policy !== 'fallback') {
      return {
        ok: false,
        code: 'not_supported_yet',
        reason: `Routing policy "${policy}" is not implemented yet (D12); use fixed or fallback.`,
      };
    }

    if (node.providerId === undefined || node.modelId === undefined || node.modelId === '') {
      return {
        ok: false,
        code: 'missing_model',
        reason: 'This node has no provider and model chosen yet.',
      };
    }

    // A failure the chain cannot survive ends it wherever it happened.
    const blocking = attemptState.failures.find((failure) => !FALLBACK_KINDS.has(failure.kind));
    if (blocking !== undefined) {
      return {
        ok: false,
        code: 'no_candidate_left',
        reason: `"${blocking.modelId}" failed with a ${blocking.kind} error, which another model would hit too.`,
      };
    }

    const chain =
      policy === 'fixed' ? [node.modelId] : [node.modelId, ...node.routing.fallbackModelIds];
    const failed = new Set(attemptState.failures.map((failure) => failure.modelId));

    let firstRefusal: { code: RouteRefusalCode; reason: string } | undefined;

    for (const [index, modelId] of chain.entries()) {
      if (failed.has(modelId)) continue;

      const model = find(modelId, node.providerId, index === 0);
      const refusal = checkCandidate(model, modelId, requirements);

      if (refusal === undefined && model !== undefined) {
        return {
          ok: true,
          route: { providerId: model.providerId, modelId: model.modelId, viaFallback: index > 0 },
        };
      }

      // The primary's refusal is the one worth reporting: a later entry the catalog does not
      // offer is skipped quietly, because the chain is a list of preferences, not requirements.
      firstRefusal ??= {
        code: refusal ?? 'unavailable_model',
        reason:
          refusal === 'incompatible_model'
            ? `"${modelId}" cannot read ${requirements.inputTypes.join(', ')} or produce ${requirements.outputTypes.join(', ')}.`
            : `"${modelId}" is not in the catalog or is not available.`,
      };
    }

    if (firstRefusal !== undefined && attemptState.failures.length === 0) return { ok: false, ...firstRefusal };

    return {
      ok: false,
      code: 'no_candidate_left',
      reason:
        chain.length === 1
          ? `"${node.modelId}" failed and this node uses fixed routing, so there is nothing else to try.`
          : `Every model in the fallback chain (${chain.join(' → ')}) has been tried.`,
    };
  }

  return {
    resolve,

    resolveForBench(node, requirements, attemptState) {
      if (node.routing.policy !== 'fixed') {
        return {
          ok: false,
          code: 'policy_not_allowed',
          reason: `A bench run must be reproducible, so it always uses fixed routing; this node uses "${node.routing.policy}" (FR-RTR-007).`,
        };
      }
      return resolve(node, requirements, attemptState);
    },
  };
}
