import type { Checkpoint } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import {
  PROJECT_ID,
  createRunDriverHarness,
  deferred,
  httpError,
  scope,
  type RunDriverHarness,
} from '../../__tests__/run-driver-harness.js';
import type { CheckpointMeta, CheckpointRecorder } from '../../ports/index.js';

const AT = '2026-10-14T10:00:00.000Z';

interface Recorded {
  projectId: string;
  meta: CheckpointMeta;
  /** How many node.state frames the run had emitted when the checkpoint began. */
  framesAtBegin: number;
  finished: number;
}

function fakeRecorder(h: () => RunDriverHarness, options: { failBegin?: boolean } = {}) {
  const recordings: Recorded[] = [];
  const recorder: CheckpointRecorder = {
    async begin(projectId, meta) {
      if (options.failBegin === true) throw new Error('store broke');
      const entry: Recorded = {
        projectId,
        meta,
        framesAtBegin: h().events.filter((event) => event.type === 'node.state').length,
        finished: 0,
      };
      recordings.push(entry);
      return {
        id: `cp${recordings.length}`,
        finish: async () => {
          entry.finished += 1;
          return undefined as Checkpoint | undefined;
        },
      };
    },
  };
  return { recorder, recordings };
}

async function harness(folderPath: string, options: { failBegin?: boolean } = {}) {
  const ref: { h?: RunDriverHarness } = {};
  const { recorder, recordings } = fakeRecorder(() => ref.h!, options);
  const h = await createRunDriverHarness({ checkpoints: recorder });
  ref.h = h;
  await h.repository.projects.create(scope, {
    id: PROJECT_ID,
    name: 'Demo',
    folderPath,
    createdAt: AT,
    updatedAt: AT,
  });
  const brief = h.inputNode();
  const writer = h.agentNode('Writer');
  const result = h.outputNode();
  await h.seed([brief, writer, result], [h.edge(brief, writer), h.edge(writer, result)]);
  return { h, recordings, writer };
}

describe('D300 run checkpoints', () => {
  it('begins one before the run drives, and finishes it when the run ends', async () => {
    const { h, recordings } = await harness('D:/demo');
    h.scripts.set('Writer', [{ text: 'done' }]);
    const begun = await h.start();
    const ended = await begun.done;
    expect(ended.status).toBe('COMPLETE');
    expect(recordings).toEqual([
      {
        projectId: PROJECT_ID,
        meta: { kind: 'run', runId: begun.run.id },
        framesAtBegin: 0,
        finished: 1,
      },
    ]);
  });

  it('records nothing for a project without a folder', async () => {
    const { h, recordings } = await harness('');
    h.scripts.set('Writer', [{ text: 'done' }]);
    await (
      await h.start()
    ).done;
    expect(recordings).toEqual([]);
  });

  it('finishes a run that halts on a failure', async () => {
    const { h, recordings } = await harness('D:/demo');
    h.scripts.set('Writer', [{ throws: httpError(400, 'bad request') }]);
    const ended = await (await h.start()).done;
    expect(ended.status).toBe('HALTED');
    expect(recordings[0]?.finished).toBe(1);
  });

  it('finishes a stopped run', async () => {
    const { h, recordings, writer } = await harness('D:/demo');
    const hold = deferred();
    h.scripts.set('Writer', [{ text: 'never', hold: hold.promise }]);
    const begun = await h.start();
    await h.waitForState(writer.id, 'RUNNING');
    await h.controls.stop(begun.run.id);
    await begun.done;
    expect(recordings[0]?.finished).toBe(1);
  });

  it('keeps a Domain run’s checkpoint recording while it stays open, and finishes it at the end', async () => {
    const { h, recordings } = await harness('D:/demo');
    h.scripts.set('Writer', [{ text: 'done' }]);
    const begun = await h.start({ domain: { stayOpen: true } });
    await h.waitForEvent('run.parked');
    expect(recordings[0]?.finished).toBe(0);
    await h.end(begun.run.id);
    await begun.done;
    expect(recordings[0]?.finished).toBe(1);
  });

  it('still runs when the checkpoint cannot begin', async () => {
    const { h } = await harness('D:/demo', { failBegin: true });
    h.scripts.set('Writer', [{ text: 'done' }]);
    expect((await (await h.start()).done).status).toBe('COMPLETE');
  });
});
