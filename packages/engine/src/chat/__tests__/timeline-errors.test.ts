import { describe, expect, it } from 'vitest';

import { createLogger } from '../../logging/index.js';
import { newId } from '../../ids.js';
import type { Repository } from '../../ports/index.js';
import { FakeRepository } from '../../__tests__/fake-repository.js';
import { startTimelinePopulation } from '../timeline.js';
import { makeBus, makeClock, makeProject, makeWorkflow, scope } from './harness.js';

/**
 * A row that fails to write must not take the subscriber down: the queue catches it, logs it, and
 * carries on (timeline.ts, the `handle(event).catch(...)` guard). The rest of the log still replays.
 */
describe('timeline population — a failing row is logged, not thrown', () => {
  it('logs when appending a derived row throws', async () => {
    const now = makeClock();
    const projectId = newId();
    const workflow = makeWorkflow(projectId);

    // The bus is backed by a healthy repository (its own event append must succeed); the populator
    // reads a repository whose `messages.append` always throws, so `handle` rejects.
    const busRepo = new FakeRepository();
    await busRepo.projects.create(scope, makeProject());
    await busRepo.workflows.create(scope, workflow);
    const { bus } = makeBus(busRepo, now);

    const failing: Repository = {
      messages: {
        append: async () => {
          throw new Error('disk full');
        },
      },
    } as unknown as Repository;

    const lines: string[] = [];
    const logger = createLogger({
      level: 'error',
      destination: {
        write: (msg: string) => {
          lines.push(msg);
        },
      },
    });

    const populator = await startTimelinePopulation({
      repository: failing,
      bus,
      logger,
      scope,
      now,
      nextId: newId,
    });

    await bus.emit({ type: 'run.started', workflowId: workflow.id, runId: newId(), payload: {} });
    await populator.idle();
    populator.unsubscribe();

    const logged = lines.join('\n');
    expect(logged).toContain('timeline row failed');
    expect(logged).toContain('run.started');
  });
});
