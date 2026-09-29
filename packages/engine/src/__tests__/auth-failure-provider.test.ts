import { describe, expect, it } from 'vitest';

import { createRunDriverHarness, httpError, PROVIDER_ID, scope } from './run-driver-harness.js';

/**
 * TC-ERR-001 / FR-ERR-001 / Arch §28: "auth (401/403) → no retry, provider marked AuthFailed".
 *
 * A key the provider refuses mid-run is news about the provider, not only about the node: the
 * providers screen, its status chip and the next pre-flight all read the provider's state, so a 401
 * has to reach it — through the provider service, the one writer of provider state (FR-PRV-003/004),
 * and announced with `provider.status` like any other change of it.
 */

async function writerThatGets(error: Error) {
  const h = await createRunDriverHarness();
  const brief = h.inputNode();
  const writer = h.agentNode('Writer', { retries: 2 });
  const result = h.outputNode();
  h.scripts.set('Writer', [{ throws: error }]);
  await h.seed([brief, writer, result], [h.edge(brief, writer), h.edge(writer, result)]);
  const { run, done } = await h.service.beginRun(h.workflowId, {});
  await done;
  return { h, run, writer };
}

const providerStatusFrames = (h: Awaited<ReturnType<typeof writerThatGets>>['h']) =>
  h.events.filter((event) => event.type === 'provider.status').map((event) => event.payload);

describe('TC-ERR-001 FR-ERR-001 an auth failure during a run marks the provider AUTH_FAILED', () => {
  it.each([401, 403])('a %i fails the node once and marks its provider AUTH_FAILED', async (status) => {
    const { h, run, writer } = await writerThatGets(httpError(status, 'invalid x-api-key'));

    const attempts = await h.nodeRunsOf(run.id, writer.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ status: 'FAILED', error: { kind: 'auth' } });
    const message = attempts[0]?.error?.message;

    expect(await h.repository.providers.get(scope, PROVIDER_ID)).toMatchObject({
      status: 'AUTH_FAILED',
      statusMessage: message,
    });
    expect(providerStatusFrames(h)).toEqual([
      { providerId: PROVIDER_ID, status: 'AUTH_FAILED', message },
    ]);
  });

  it('leaves the provider alone when the failure says nothing about its key', async () => {
    const { h } = await writerThatGets(httpError(400, 'bad request'));

    expect((await h.repository.providers.get(scope, PROVIDER_ID))?.status).toBe('CONNECTED');
    expect(providerStatusFrames(h)).toEqual([]);
  });
});

describe('FR-PRV-003 FR-PRV-004 recordStatus is the provider service’s one way to change a state', () => {
  it('stores and announces a state, and leaves a provider that no longer exists alone', async () => {
    const h = await createRunDriverHarness();

    await h.providers.recordStatus(PROVIDER_ID, { status: 'RATE_LIMITED' });
    await h.providers.recordStatus('01JBXQ8Z9KQ4R7N2VWXYZ0GONE0', { status: 'AUTH_FAILED' });

    const stored = await h.repository.providers.get(scope, PROVIDER_ID);
    expect(stored?.status).toBe('RATE_LIMITED');
    // No message this time, so none is left over from before.
    expect(stored?.statusMessage).toBeUndefined();
    expect(stored?.lastCheckedAt).toBeDefined();
    expect(h.events.filter((event) => event.type === 'provider.status').map((e) => e.payload)).toEqual([
      { providerId: PROVIDER_ID, status: 'RATE_LIMITED' },
    ]);
  });
});
