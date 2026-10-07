import type {
  CreateSecretRequest,
  Id,
  Secret,
  UpdateSecretRequest,
  ValidationIssue,
} from '@ace/contracts';

import type { EmittedEvent } from '../events/index.js';
import { HttpError, notFound, notImplemented, validationFailed } from '../gateway/errors.js';
import type { Logger } from '../logging/index.js';
import type { Repository, Scope, SecretRepository, SecretStore } from '../ports/index.js';
import { looksLikeSecret } from '../security/secret-patterns.js';

/**
 * Secrets — named environment variables (ACE parity P1, D274, FR-PRV-002, BR-07, NFR-SEC-02).
 *
 * A secret is two things kept in two places. Its **row** — name, description, project scope — is in
 * the database through `SecretRepository`. Its **value** is only ever written to the `SecretStore`
 * (the OS keychain) under `secret:env:<NAME>`, and nothing this service answers carries it: the API
 * shows the row, never the value.
 *
 * Where a value goes: check, setup and preview commands and CLI agent processes of the projects in
 * scope receive it as an environment variable (`envFor`). Where it must never stay: every persisted
 * event and stored check output passes through `scrubber()`, which replaces each exact value of
 * {@link SCRUB_MIN_LENGTH}+ characters with `[SECRET:<NAME>]`. The values are held in memory for
 * that — loaded at start, refreshed on every create, update and delete — so a scrub is a string
 * replace, never a keychain round trip.
 */

/** Where a secret's value lives in the keychain. Provider keys use `provider:<id>:apiKey`. */
export const secretStoreKey = (name: string): string => `secret:env:${name}`;

/** Values shorter than this are not scrubbed: a two-letter value would rewrite ordinary words. */
export const SCRUB_MIN_LENGTH = 4;

/** How much of a name a shortened marker keeps: under the label rule's 32-character run. */
const MARKER_NAME_MAX = 31;

/**
 * What an exact value is replaced with in an event or a check's output: `[SECRET:<NAME>]`.
 *
 * One exception. Behind `SECRET:`, a name of 32+ characters that mixes letters and digits (say
 * `S3_UPLOAD_ACCESS_KEY_FOR_PRODUCTION`) reads as a labelled credential to the shared secret
 * patterns — so the store's guard would refuse the very event the marker was meant to make safe,
 * and the run would fail on it. Such a name is shortened to its first 31 characters and `…`.
 */
export const scrubMarker = (name: string): string => {
  const marker = `[SECRET:${name}]`;
  return looksLikeSecret(marker) ? `[SECRET:${name.slice(0, MARKER_NAME_MAX)}…]` : marker;
};

export interface SecretService {
  /** `GET /secrets` — every secret by name, never a value. */
  list(): Promise<Secret[]>;
  /** `POST /secrets` — 409 `name_taken` when the name exists; the value goes only to the keychain. */
  create(request: CreateSecretRequest): Promise<Secret>;
  /** `PATCH /secrets/:name` — a new `value` replaces the stored one. */
  update(name: string, patch: UpdateSecretRequest): Promise<Secret>;
  /** `DELETE /secrets/:name` — the keychain entry goes with the row. */
  remove(name: string): Promise<void>;
  /**
   * The environment a project's commands and CLI agents get: every secret whose `projectIds` is
   * empty (all projects) or names this project, by name.
   */
  envFor(projectId: Id): Promise<Record<string, string>>;
  /**
   * Replaces every exact value of {@link SCRUB_MIN_LENGTH}+ characters with `[SECRET:<NAME>]`. The
   * function reads the live cache, so one taken once keeps up with later creates and deletes.
   */
  scrubber(): (text: string) => string;
  /** Reads every value into the cache; called once at start and after a restore. */
  load(): Promise<void>;
}

export interface SecretServiceDeps {
  repository: Repository;
  scope: Scope;
  store: SecretStore;
  logger?: Logger;
  now?: () => string;
}

const nameTaken = (name: string): HttpError =>
  new HttpError('invalid_config', 'name_taken', `A secret named ${name} already exists.`, {
    name,
  });

const secretNotFound = (name: string): HttpError => notFound(`Secret ${name}`);

/** The same `ValidationIssue` shape every other refusal uses. */
const unknownProject = (projectId: Id): HttpError => {
  const message = `Project ${projectId} was not found.`;
  const issue: ValidationIssue = { severity: 'error', code: 'unknown_project', message };
  return validationFailed(message, [issue]);
};

/** Ids in the order given, each once. */
const distinct = (ids: readonly Id[]): Id[] => [...new Set(ids)];

const inScope = (secret: Secret, projectId: Id): boolean =>
  secret.projectIds.length === 0 || secret.projectIds.includes(projectId);

export function createSecretService(deps: SecretServiceDeps): SecretService {
  const { repository, scope, store, logger } = deps;
  const now = deps.now ?? (() => new Date().toISOString());

  /** name → value: what the scrubber and `envFor` read. Never persisted, never logged. */
  const values = new Map<string, string>();
  /** The scrub list, longest value first, so a value that contains another is replaced whole. */
  let scrubList: { value: string; marker: string }[] = [];

  const rebuild = (): void => {
    scrubList = [...values]
      .filter(([, value]) => value.length >= SCRUB_MIN_LENGTH)
      .sort(([, a], [, b]) => b.length - a.length)
      .map(([name, value]) => ({ value, marker: scrubMarker(name) }));
  };

  const remember = (name: string, value: string): void => {
    values.set(name, value);
    rebuild();
  };

  const forget = (name: string): void => {
    values.delete(name);
    rebuild();
  };

  const rows = (): SecretRepository => {
    if (repository.secrets === undefined) throw notImplemented('secrets');
    return repository.secrets;
  };

  async function checkProjects(projectIds: readonly Id[]): Promise<void> {
    for (const projectId of projectIds) {
      if ((await repository.projects.get(scope, projectId)) === null) {
        throw unknownProject(projectId);
      }
    }
  }

  /** The value of one secret: the cache, else the keychain (a value the start could not read). */
  async function valueOf(name: string): Promise<string | undefined> {
    const cached = values.get(name);
    if (cached !== undefined) return cached;
    try {
      const stored = await store.get(scope, secretStoreKey(name));
      if (stored === null) return undefined;
      remember(name, stored);
      return stored;
    } catch (error) {
      logger?.warn({ subsystem: 'secrets', err: error, name }, 'a secret value could not be read');
      return undefined;
    }
  }

  return {
    list: async () => rows().list(scope),

    async create(request) {
      const repo = rows();
      if ((await repo.get(scope, request.name)) !== null) throw nameTaken(request.name);
      const projectIds = distinct(request.projectIds ?? []);
      await checkProjects(projectIds);

      const timestamp = now();
      const secret: Secret = {
        name: request.name,
        description: request.description ?? '',
        projectIds,
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      // The value first: a row whose value never reached the keychain would be a secret that
      // silently sets nothing. If the row then fails, the value is taken back out.
      await store.set(scope, secretStoreKey(secret.name), request.value);
      try {
        await repo.create(scope, secret);
      } catch (error) {
        await store.delete(scope, secretStoreKey(secret.name)).catch(() => false);
        // Two creates of one name that both passed the check: the second is the one refused.
        if ((await repo.get(scope, secret.name)) !== null) throw nameTaken(secret.name);
        throw error;
      }
      remember(secret.name, request.value);
      return secret;
    },

    async update(name, patch) {
      const repo = rows();
      const existing = await repo.get(scope, name);
      if (existing === null) throw secretNotFound(name);
      const projectIds =
        patch.projectIds === undefined ? existing.projectIds : distinct(patch.projectIds);
      if (patch.projectIds !== undefined) await checkProjects(projectIds);

      if (patch.value !== undefined) {
        await store.set(scope, secretStoreKey(name), patch.value);
        remember(name, patch.value);
      }
      return repo.save(scope, {
        ...existing,
        ...(patch.description === undefined ? {} : { description: patch.description }),
        projectIds,
        updatedAt: now(),
      });
    },

    async remove(name) {
      const repo = rows();
      if ((await repo.get(scope, name)) === null) throw secretNotFound(name);
      // The keychain entry first: if it cannot be removed the row stays, so the user can try again
      // rather than be left with a value nothing lists.
      await store.delete(scope, secretStoreKey(name));
      forget(name);
      await repo.delete(scope, name);
    },

    async envFor(projectId) {
      const env: Record<string, string> = {};
      for (const secret of await rows().list(scope)) {
        if (!inScope(secret, projectId)) continue;
        const value = await valueOf(secret.name);
        if (value !== undefined) env[secret.name] = value;
      }
      return env;
    },

    scrubber: () => (text) => {
      if (scrubList.length === 0 || text.length < SCRUB_MIN_LENGTH) return text;
      let out = text;
      for (const { value, marker } of scrubList) {
        if (out.includes(value)) out = out.split(value).join(marker);
      }
      return out;
    },

    async load() {
      values.clear();
      rebuild();
      if (repository.secrets === undefined) return;
      for (const secret of await repository.secrets.list(scope)) {
        // One unreadable value is logged and skipped; it is retried the first time it is needed.
        await valueOf(secret.name);
      }
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Scrubbing structured values                                                 */
/* -------------------------------------------------------------------------- */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Every string in a JSON-shaped value through `scrub` — object keys included, since a key can carry
 * text as surely as a value can. What nothing changed is returned as the same reference, so a
 * payload with no secret in it costs a walk and no copy.
 */
export function scrubDeep<T>(value: T, scrub: (text: string) => string): T {
  if (typeof value === 'string') return scrub(value) as T;
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item: unknown) => {
      const scrubbed = scrubDeep(item, scrub);
      if (scrubbed !== item) changed = true;
      return scrubbed;
    });
    return (changed ? next : value) as T;
  }
  if (isPlainObject(value)) {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const scrubbedKey = scrub(key);
      const scrubbed = scrubDeep(item, scrub);
      if (scrubbedKey !== key || scrubbed !== item) changed = true;
      next[scrubbedKey] = scrubbed;
    }
    return (changed ? next : value) as T;
  }
  return value;
}

/** An event bus `scrub` (D274): the payload's every string through the exact-value scrubber. */
export function eventScrubber(
  scrub: (text: string) => string,
): (event: EmittedEvent) => EmittedEvent {
  return (event) => {
    const payload = scrubDeep(event.payload, scrub);
    return payload === event.payload ? event : { ...event, payload };
  };
}
